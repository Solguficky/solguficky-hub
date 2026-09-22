using System.Diagnostics;
using System.Reflection;
using System.Text.RegularExpressions;
using Dapper;
using DbUp;
using DbUp.Engine;
using Npgsql;

namespace Notifications;

/// <summary>
/// Применение схемы при старте процесса. Один механизм на сервис — DbUp:
/// <c>docs/standards/data/postgresql.md</c> запрещает два журнала на одну схему,
/// поэтому вендорные скрипты Orleans идут этим же runner-ом, а не своим.
/// </summary>
public static partial class Migrations
{
    public const string DatabaseUrlVariable = "NOTIFICATIONS_DATABASE_URL";

    private const string JournalTable = "notifications_schema_versions";

    /// <summary>Ключ advisory lock. Произвольная константа, лишь бы своя.</summary>
    private const long LockKey = 615204877L;

    private const double LockWaitSeconds = 60.0;

    private const string ResourceMarker = ".Migrations.";

    [GeneratedRegex(@"^(\d{3})_(.+)\.sql$", RegexOptions.CultureInvariant)]
    private static partial Regex FileName();

    public sealed record Migration(int Version, string Name, string Resource, string Sql);

    /// <summary>
    /// Единственное место, где решается, что такое миграция. Проверки ниже —
    /// не документация, а гейт: любой встроенный <c>.sql</c> либо назван по
    /// нормативу, либо роняет старт.
    /// </summary>
    public static IReadOnlyList<Migration> List()
    {
        var assembly = Assembly.GetExecutingAssembly();

        var migrations = assembly.GetManifestResourceNames()
            .Where(resource =>
                resource.Contains(ResourceMarker, StringComparison.Ordinal)
                && resource.EndsWith(".sql", StringComparison.Ordinal))
            // Порядок задаёт имя, а не содержимое: тот же порядок применит DbUp.
            .OrderBy(resource => resource, StringComparer.Ordinal)
            .Select(resource =>
            {
                var index = resource.IndexOf(ResourceMarker, StringComparison.Ordinal);
                var file = resource[(index + ResourceMarker.Length)..];
                var matched = FileName().Match(file);

                if (!matched.Success)
                {
                    throw new InvalidOperationException(
                        $"embedded notifications migration {file} is not named NNN_description.sql");
                }

                using var stream = assembly.GetManifestResourceStream(resource)
                    ?? throw new InvalidOperationException($"cannot read embedded resource {resource}");
                using var reader = new StreamReader(stream);

                return new Migration(
                    int.Parse(matched.Groups[1].Value),
                    matched.Groups[2].Value,
                    resource,
                    reader.ReadToEnd());
            })
            .ToList();

        // Строго возрастающие версии в порядке имён: так проверяется и
        // уникальность номера, и что имя не потеряло ведущие нули, иначе `010`
        // шло бы перед `9`.
        foreach (var (previous, next) in migrations.Zip(migrations.Skip(1)))
        {
            if (next.Version <= previous.Version)
            {
                throw new InvalidOperationException(
                    $"embedded notifications migrations are out of order: {previous.Resource} then {next.Resource}");
            }
        }

        return migrations;
    }

    /// <summary>
    /// Принимает и готовую строку Npgsql, и URI вида <c>postgres://…</c>.
    /// Aspire и Testcontainers дают первую форму, ручной запуск обычно вторую.
    /// </summary>
    public static string ConnectionString(string dsn)
    {
        if (!dsn.Contains("://", StringComparison.Ordinal))
        {
            return dsn;
        }

        var uri = new Uri(dsn);
        var builder = new NpgsqlConnectionStringBuilder { Host = uri.Host };

        if (uri.Port > 0)
        {
            builder.Port = uri.Port;
        }

        var userInfo = uri.UserInfo;
        var colon = userInfo.IndexOf(':');

        if (colon < 0)
        {
            if (userInfo.Length > 0)
            {
                builder.Username = Uri.UnescapeDataString(userInfo);
            }
        }
        else
        {
            builder.Username = Uri.UnescapeDataString(userInfo[..colon]);
            builder.Password = Uri.UnescapeDataString(userInfo[(colon + 1)..]);
        }

        var database = Uri.UnescapeDataString(uri.AbsolutePath).Trim('/');

        if (database.Length > 0)
        {
            builder.Database = database;
        }

        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            var key = Uri.UnescapeDataString(parts[0]).ToLowerInvariant();
            var value = parts.Length == 2 ? Uri.UnescapeDataString(parts[1]) : string.Empty;

            // Ключа нет в таблице — падаем, а не роняем параметр молча: тихо
            // потерянный `sslmode=verify-full` понижает TLS до неверифицируемого.
            if (key == "sslmode")
            {
                builder.SslMode = SslModeFrom(value);
            }
            else
            {
                builder[KeywordFor(key)] = value;
            }
        }

        return builder.ConnectionString;
    }

    /// <summary>
    /// Значение `sslmode` тоже требует перевода, а не только ключ: libpq пишет
    /// `verify-full` и `verify-ca` через дефис, а в перечислении Npgsql дефиса
    /// нет. Без нормализации отвергались бы ровно те два режима, которые
    /// единственные верифицируют сервер, — то есть защита ломала бы защиту.
    /// </summary>
    private static SslMode SslModeFrom(string value)
    {
        var normalized = value.Replace("-", string.Empty).Replace("_", string.Empty);

        return Enum.TryParse<SslMode>(normalized, ignoreCase: true, out var mode)
            ? mode
            : throw new InvalidOperationException($"unsupported sslmode {value} in {DatabaseUrlVariable}");
    }

    private static string KeywordFor(string key) => key switch
    {
        "host" => "Host",
        "port" => "Port",
        "dbname" => "Database",
        "user" => "Username",
        "password" => "Password",
        "application_name" => "Application Name",
        "connect_timeout" => "Timeout",
        "options" => "Options",
        "sslrootcert" => "Root Certificate",
        _ => throw new InvalidOperationException($"unsupported parameter {key} in {DatabaseUrlVariable}"),
    };

    /// <summary>
    /// Сериализует старт нескольких экземпляров. Ожидание ограничено: без предела
    /// зависший держатель блокировки останавливал бы каждый следующий процесс
    /// навсегда, до того как Kestrel вообще откроет порт.
    /// </summary>
    private static void AcquireLock(NpgsqlConnection connection)
    {
        var deadline = Stopwatch.StartNew();

        while (deadline.Elapsed.TotalSeconds < LockWaitSeconds)
        {
            if (connection.ExecuteScalar<bool>("SELECT pg_try_advisory_lock(@key)", new { key = LockKey }))
            {
                return;
            }

            Thread.Sleep(TimeSpan.FromMilliseconds(200));
        }

        throw new InvalidOperationException(
            $"notifications schema lock is held by another process after {LockWaitSeconds} s");
    }

    public static void Apply(string dsn)
    {
        var cs = ConnectionString(dsn);
        var scripts = List().Select(migration => new SqlScript(migration.Resource, migration.Sql)).ToList();

        // Пустой список — не «нечего применять», а потерянный `EmbeddedResource`:
        // DbUp на нуле скриптов рапортует успех и даже не заводит журнал, после
        // чего силос падает на отсутствующей orleansquery с ошибкой, которая про
        // миграции ничего не говорит. Отказ здесь называет причину сразу.
        if (scripts.Count == 0)
        {
            throw new InvalidOperationException(
                "no embedded notifications migrations found: check <EmbeddedResource Include=\"Migrations/*.sql\" />");
        }

        using var connection = new NpgsqlConnection(cs);
        connection.Open();
        AcquireLock(connection);

        try
        {
            var result = DeployChanges.To
                .PostgresqlDatabase(cs)
                .WithScripts(scripts)
                .JournalToPostgresqlTable("public", JournalTable)
                // Подстановка переменных DbUp выключена, и это несущая строка, а
                // не настройка вкуса: она разбирает `$name$` как своё имя, а
                // PL/pgSQL ровно так оформляет долларовые кавычки тела функции.
                // Скрипты кластеризации Orleans объявляют функции через `$func$`,
                // и с включённой подстановкой миграция падает на первом же из них
                // с «Variable func has no value defined».
                .WithVariablesDisabled()
                .WithTransaction()
                .LogToConsole()
                .Build()
                .PerformUpgrade();

            if (!result.Successful)
            {
                throw result.Error ?? new InvalidOperationException("notifications schema upgrade failed");
            }
        }
        finally
        {
            // Снятие блокировки не должно подменять собой настоящую причину отказа:
            // если соединение-держатель сломалось вместе с прогоном, исключение из
            // finally вытеснило бы ошибку схемы, и оператор прочитал бы про
            // транспорт вместо миграции. Блокировка сессионная, поэтому при
            // разорванном соединении её снимает сам PostgreSQL.
            try
            {
                connection.ExecuteScalar<bool>("SELECT pg_advisory_unlock(@key)", new { key = LockKey });
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"notifications schema lock release failed: {ex.Message}");
            }
        }
    }
}
