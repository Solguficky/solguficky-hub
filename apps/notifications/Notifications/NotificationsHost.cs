using System.Net;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using NATS.Client.Core;
using NATS.Client.JetStream;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Preferences;
using Notifications.Reminders;
using Notifications.Replica;
using Notifications.Transport;
using Notifications.V1;
using Npgsql;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using Orleans.Configuration;

namespace Notifications;

/// <summary>
/// Composition root сервиса. Вынесен из <c>Program</c> отдельной функцией, чтобы
/// интеграционный тест поднимал ровно тот же хост, что и запуск: иначе критерий
/// «грин переживает рестарт» навсегда остаётся ручным прогоном.
/// </summary>
/// <remarks>
/// Имя не <c>Host</c> намеренно: под <c>ImplicitUsings</c> оно сталкивается с
/// <c>Microsoft.Extensions.Hosting.Host</c>, и ссылка становится неоднозначной.
/// </remarks>
public static class NotificationsHost
{
    /// <summary>Имя кластера. Общее для всех силосов одного развёртывания.</summary>
    public const string ClusterId = "solguficky";

    /// <summary>Имя сервиса. Переживает пересоздание кластера.</summary>
    public const string ServiceId = "notifications";

    /// <summary>Инвариант ADO.NET для PostgreSQL, как его знает Orleans.</summary>
    private const string AdoNetInvariant = "Npgsql";

    /// <summary>Ключи конфигурации портов силоса. Их задаёт тот, кто поднимает второй силос.</summary>
    public const string SiloPortKey = "Orleans:SiloPort";

    /// <inheritdoc cref="SiloPortKey" />
    public const string GatewayPortKey = "Orleans:GatewayPort";

    /// <summary>Адрес NATS, из которого сервис читает чужие факты.</summary>
    public const string NatsUrlVariable = "NOTIFICATIONS_NATS_URL";

    /// <param name="natsUrl">
    /// Адрес шины. Без него потребители реплики не регистрируются: так тест,
    /// которому шина не нужна, поднимает тот же composition root без неё.
    /// Сам сервис без адреса не стартует — это решает <c>Program</c>, а не
    /// эта функция.
    /// </param>
    public static WebApplication Build(string[] args, string databaseUrl, string? natsUrl = null)
    {
        var builder = WebApplication.CreateBuilder(args);
        var connectionString = Migrations.ConnectionString(databaseUrl);

        builder.AddServiceDefaults();
        builder.Services.AddSingleton<ReminderTelemetry>();
        builder.Services.AddSingleton<ReplicaTelemetry>();
        builder.Services.AddSingleton<FactTelemetry>();
        builder.Services.AddOpenTelemetry()
            .WithMetrics(metrics => metrics
                .AddMeter(ReminderTelemetry.MeterName)
                .AddMeter(ReplicaTelemetry.MeterName)
                .AddMeter(FactTelemetry.MeterName));

        // Локальный diagnostics-профиль пишет те же логи в Loki через OTLP.
        // Обычные профили продолжают экспортировать их только в Aspire.
        var lokiEndpoint = builder.Configuration["NOTIFICATIONS_LOKI_OTLP_ENDPOINT"];
        if (!string.IsNullOrWhiteSpace(lokiEndpoint))
        {
            builder.Services.Configure<OpenTelemetryLoggerOptions>(logging =>
                logging.AddOtlpExporter(exporter =>
                {
                    exporter.Endpoint = new Uri(new Uri(lokiEndpoint.TrimEnd('/') + "/"), "otlp/v1/logs");
                    exporter.Protocol = OtlpExportProtocol.HttpProtobuf;
                }));
        }

        // h2c: gRPC без TLS требует HTTP/2, а plaintext-endpoint без ALPN не умеет
        // договариваться о версии. Протокол задан кодом, а не appsettings.json,
        // потому что без него транспорт не работает вовсе. Форма повторяет Meetups.
        builder.WebHost.ConfigureKestrel(options =>
            options.ConfigureEndpointDefaults(endpoint => endpoint.Protocols = HttpProtocols.Http2));

        // Grain storage по-прежнему сознательно не регистрируется: источник
        // истины остаётся в PostgreSQL (ADR-029), а отсутствие провайдера
        // работает гейтом — [PersistentState] роняет первую активацию грина, а
        // не старт силоса, поэтому ловит его тест, а не проба готовности.
        //
        // Reminders, в отличие от него, зарегистрированы (PER-222), и это не
        // ослабление того же правила. Reminder хранит определение напоминания,
        // а не его срабатывание: момент лежит строкой в reminder_task, а
        // рантайм только будит грин к этому моменту. Пропущенный за время
        // простоя тик Orleans не догоняет, поэтому корректность держит sweeper
        // по таблице, а не этот провайдер.
        builder.UseOrleans(silo =>
        {
            silo.Configure<ClusterOptions>(options =>
            {
                options.ClusterId = ClusterId;
                options.ServiceId = ServiceId;
            });

            // Восстановление после неснятого падения держится на том, что
            // поднявшийся силос занимает тот же адрес, что и умерший.
            //
            // Orleans при входе в кластер пингует все записи в состоянии Active
            // и без ответа не входит, а запись убитого силоса остаётся Active —
            // закрыть её было некому. Записи того же логического силоса (тот же
            // адрес, другое поколение) проверка пропускает, поэтому рестарт на
            // прежнем порту проходит, а на новом — нет: новый порт делает силос
            // другим логическим силосом, и он пять минут ждёт ответа от
            // покойника, после чего падает с OrleansClusterConnectivityCheckFailed.
            //
            // Отключить проверку в Orleans 10 нечем: флага ValidateInitialConnectivity
            // здесь больше нет. Порты и так берутся из конфигурации со штатными
            // умолчаниями — Aspire их не переопределяет, — поэтому рестарт
            // развёртывания попадает на прежний адрес сам собой. Переопределяет
            // их только тот, кто поднимает второй силос на той же машине.

            // Силос слушает петлю: Aspire запускает сервис локальным процессом,
            // а адрес из membership переживает рестарт и указывал бы на чужой
            // интерфейс, если бы силос объявил адрес LAN.
            //
            // Порты берутся из конфигурации, а не зашиты: два силоса на одной
            // машине — это и параллельные рабочие деревья, и тест рестарта,
            // который поднимает второй хост. Умолчания — штатные для Orleans,
            // поэтому Aspire ничего не передаёт.
            var siloPort = builder.Configuration.GetValue(SiloPortKey, EndpointOptions.DEFAULT_SILO_PORT);
            var gatewayPort = builder.Configuration.GetValue(GatewayPortKey, EndpointOptions.DEFAULT_GATEWAY_PORT);

            silo.Configure<EndpointOptions>(options =>
            {
                options.AdvertisedIPAddress = IPAddress.Loopback;
                options.SiloPort = siloPort;
                options.GatewayPort = gatewayPort;
            });

            silo.UseAdoNetClustering(options =>
            {
                options.Invariant = AdoNetInvariant;
                options.ConnectionString = connectionString;
            });

            // Таблицы reminder'ов заводит тот же DbUp, что и membership:
            // standards/data/postgresql.md запрещает два журнала на одну схему,
            // поэтому вендорный скрипт лежит рядом с остальными миграциями.
            silo.UseAdoNetReminderService(options =>
            {
                options.Invariant = AdoNetInvariant;
                options.ConnectionString = connectionString;
            });
        });

        // В отличие от Meetups хост НЕ поднимается без базы, и это не упущение:
        // membership силоса лежит в PostgreSQL, поэтому силос без базы — не силос.
        // Источник соединений при этом остаётся ленивым, как у соседа.
        //
        // Регистрируется фабрикой, а не готовым экземпляром, и это не стиль:
        // контейнер утилизирует только то, что создал сам, поэтому переданный
        // ему извне NpgsqlDataSource пережил бы остановку хоста вместе со своим
        // пулом соединений. Meetups регистрирует свой источник тем же способом.
        //
        // Предел подключения ставится пулу сервиса, а не общей строке: clustering
        // и reminders Orleans живут на своих пределах. Пул сервиса делят gRPC,
        // грин и фоновые пути, поэтому быстрее отказывают все они; фоновые
        // повторяются следующим тиком или повтором сообщения, и это приемлемо.
        builder.Services.AddSingleton(_ =>
            NpgsqlDataSource.Create(StorageAvailability.WithConnectTimeout(connectionString)));
        builder.Services.AddSingleton<GrainActivationStore>();
        builder.Services.AddSingleton<ReminderTaskStore>();

        // Часы — зависимость, а не вызов DateTimeOffset.UtcNow по коду:
        // standards/testing/testing-strategy.md требует, чтобы тест не зависел
        // от часов машины, а период прохода sweeper'а иначе нечем двигать.
        builder.Services.AddSingleton(TimeProvider.System);

        // Пояс сообщества разбирается здесь, при сборке хоста, а не при первом
        // событии: пустое и неизвестное имя роняют старт, а не каждое
        // применение сходки. Program проверяет то же раньше ради внятной строки.
        builder.Services.AddSingleton(CommunityTime.Parse(builder.Configuration[CommunityTime.TimeZoneVariable]));

        builder.Services.Configure<MeetupReminderOptions>(
            builder.Configuration.GetSection(MeetupReminderOptions.SectionName));

        builder.Services.AddHostedService<ReminderSweeper>();

        // Реплика чужих фактов (PER-215). Хранилище и чистка ключей не зависят
        // от шины: таблица ключей существует и без неё.
        builder.Services.AddSingleton<ReplicaStore>();
        // Срок хранения ключей сверяет с настоящим стримом сам потребитель при
        // привязке: копия настройки стрима здесь прошла бы молча, когда
        // топология поднимет окно хранения.
        builder.Services.Configure<ReplicaOptions>(builder.Configuration.GetSection(ReplicaOptions.SectionName));
        builder.Services.AddHostedService<ConsumedEventPruner>();

        // Адресные факты (PER-216). Порождаются в транзакции реплики, а в шину
        // их выносит релей — он есть только там, где есть шина.
        builder.Services.AddSingleton<NotificationStore>();
        // Отрицательный срок молча снял бы каждый факт, а огромный переполнил
        // бы момент и уронил применение каждого события сходки: оба ловятся на
        // старте, а не на первом поводе.
        builder.Services.AddOptions<FactOptions>()
            .Bind(builder.Configuration.GetSection(FactOptions.SectionName))
            .Validate(FactOptions.IsValid, FactOptions.ValidationMessage)
            .ValidateOnStart();
        builder.Services.Configure<DispatchOptions>(builder.Configuration.GetSection(DispatchOptions.SectionName));

        if (natsUrl is not null)
        {
            builder.Services.AddSingleton(_ => new NatsConnection(new NatsOpts { Url = natsUrl, Name = ServiceId }));
            builder.Services.AddSingleton<INatsJSContext>(services =>
                new NatsJSContext(services.GetRequiredService<NatsConnection>()));

            // Раньше потребителей: соединение открывается лениво, на первом их
            // обращении, и подписка на его события должна его опередить.
            builder.Services.AddHostedService<BusConnectionWatcher>();

            // AddSingleton, а не AddHostedService: тот регистрирует через
            // TryAddEnumerable по типу реализации, и второй потребитель того же
            // типа молча не зарегистрировался бы.
            foreach (var feed in ReplicaFeeds.All)
            {
                builder.Services.AddSingleton<IHostedService>(services =>
                    ActivatorUtilities.CreateInstance<ReplicaConsumer>(services, feed));
            }

            builder.Services.AddHostedService<NotificationDispatcher>();
        }

        // Подписки и настройки категорий. Ни один из трёх типов не знает про
        // Orleans: команды синхронны, а источник истины остаётся в PostgreSQL
        // (ADR-029). Задание напоминания их тоже не трогает — аудитория
        // разворачивается в момент срабатывания, а не при подписке.
        builder.Services.AddSingleton<SubscriptionStore>();
        builder.Services.AddSingleton<PreferenceStore>();
        builder.Services.AddSingleton<PreferenceOperations>();

        // Сам gRPC-стек. Без него не поднимаются ни проба, ни рефлексия: обе
        // маппятся как gRPC-сервисы.
        builder.Services.AddGrpc(options => options.Interceptors.Add<BoundaryLogInterceptor>());

        // Готовность — отвечает ли база. Проверка идёт на каждый Check пробы, а не
        // фоном: кэш результатов в мосте выключен по умолчанию, и статус не
        // отстаёт от базы на период публикации.
        builder.Services.AddHealthChecks()
            .AddCheck<DatabaseReadiness>(
                "postgres",
                failureStatus: null,
                tags: [DatabaseReadiness.Tag],
                timeout: DatabaseReadiness.Timeout);

        // Мост из health checks в grpc.health.v1. Пустое имя отвечает liveness и
        // базу не спрашивает, имя сервиса — readiness, и её спрашивает проба
        // AppHost. Умолчание моста отдало бы пустому имени все проверки сразу,
        // поэтому сопоставление задано явно.
        builder.Services.AddGrpcHealthChecks(options =>
        {
            options.Services.Clear();
            options.Services.Map("", check => check.Tags.Contains(DatabaseReadiness.LiveTag));
            options.Services.Map(
                NotificationsService.Descriptor.FullName,
                check => check.Tags.Contains(DatabaseReadiness.LiveTag) || check.Tags.Contains(DatabaseReadiness.Tag));
        });

        // Reflection включён безусловно, как в Identity и Meetups: иначе каждая
        // ручная проверка grpcurl требует -import-path и -proto.
        builder.Services.AddGrpcReflection();

        var app = builder.Build();

        app.MapGrpcHealthChecksService();
        app.MapGrpcReflectionService();

        // Command plane подписок и настроек. Обе ручные рассылки контракта
        // отвечают Unimplemented: они принадлежат блоку обращения к подписчикам
        // и требуют синхронной проверки права у владельца ресурса.
        app.MapGrpcService<NotificationsGrpcService>();

        return app;
    }
}
