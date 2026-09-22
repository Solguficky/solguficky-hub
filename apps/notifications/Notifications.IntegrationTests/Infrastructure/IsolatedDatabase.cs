using Npgsql;
using Testcontainers.PostgreSql;
using Xunit;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>
/// Общий на прогон контейнер PostgreSQL и решение «есть база или нет».
/// Форма перенесена из <c>Meetups.IntegrationTests.Infrastructure.Testdb</c>:
/// оба места, где этот вопрос решается, обязаны отвечать одинаково.
/// </summary>
public static class PostgresAdmin
{
    /// <summary>Пустая переменная — это незаданная переменная.</summary>
    public static string? Variable(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrEmpty(value) ? null : value;
    }

    /// <remarks>
    /// Своей проверки демона здесь нет: Testcontainers сам знает и unix-socket,
    /// и named pipe Docker Desktop на Windows, а рукописная проверка сокета
    /// молча пропускала бы все тесты схемы на Windows при живом Docker.
    /// </remarks>
    private static readonly Lazy<PostgreSqlContainer?> Container = new(() =>
    {
        try
        {
            var postgres = new PostgreSqlBuilder().WithImage("postgres:16-alpine").Build();
            postgres.StartAsync().GetAwaiter().GetResult();
            return postgres;
        }
        catch
        {
            return null;
        }
    });

    public static bool Started() => Container.Value is not null;

    public static string ConnectionString()
    {
        if (Container.Value is { } postgres)
        {
            return postgres.GetConnectionString();
        }

        // В CI отсутствие Testcontainers — красная джоба, а не пропуск: зелёный
        // прогон на пропущенных тестах хуже отсутствия тестов, потому что
        // выглядит как доказательство.
        if (Variable("GITHUB_ACTIONS") is not null)
        {
            throw new InvalidOperationException("testcontainers postgres is required in CI");
        }

        return Migrations.ConnectionString(
            Variable(Migrations.DatabaseUrlVariable)
            ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable");
    }
}

/// <summary>База на тест: имя уникально по построению, уборка — в Dispose.</summary>
public sealed class IsolatedDatabase : IDisposable
{
    private readonly string adminConnectionString = PostgresAdmin.ConnectionString();
    private readonly string name = "ntest_" + Guid.NewGuid().ToString("N")[..20];

    public IsolatedDatabase()
    {
        var builder = new NpgsqlConnectionStringBuilder(adminConnectionString) { Database = name };
        ConnectionString = builder.ConnectionString;

        try
        {
            using var connection = new NpgsqlConnection(adminConnectionString);
            connection.Open();
            using var create = new NpgsqlCommand("CREATE DATABASE " + name, connection);
            create.ExecuteNonQuery();
        }
        catch (Exception ex)
        {
            // Контейнер поднялся — значит база есть, и отказ CREATE DATABASE это
            // настоящая поломка, а не «постгреса рядом нет». Пропуск здесь
            // прятал бы её за зелёным прогоном.
            var forced = PostgresAdmin.Started()
                || PostgresAdmin.Variable(Migrations.DatabaseUrlVariable) is not null
                || PostgresAdmin.Variable("GITHUB_ACTIONS") is not null;

            if (forced)
            {
                throw new InvalidOperationException($"postgres: {ex.Message}", ex);
            }

            Assert.Skip($"postgres not available: {ex.Message}");
        }
    }

    public string ConnectionString { get; }

    public void Dispose()
    {
        try
        {
            // ClearAllPools здесь нет намеренно: он глобален на процесс и бил бы
            // по пулам параллельных тестовых классов, а нужды в нём нет —
            // WITH (FORCE) сам отключает оставшиеся сессии к этой базе.
            using var connection = new NpgsqlConnection(adminConnectionString);
            connection.Open();
            using var drop = new NpgsqlCommand($"DROP DATABASE IF EXISTS {name} WITH (FORCE)", connection);
            drop.ExecuteNonQuery();
        }
        catch (Exception ex)
        {
            // Уронить прогон на уборке нельзя, но и молчать нельзя: тихий отказ
            // копит осиротевшие ntest_* до упора в лимит соединений.
            Console.Error.WriteLine($"cleanup drop {name}: {ex.Message}");
        }
    }
}
