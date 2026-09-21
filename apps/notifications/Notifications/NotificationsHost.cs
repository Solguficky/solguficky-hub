using System.Net;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Notifications.Infrastructure;
using Npgsql;
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

    public static WebApplication Build(string[] args, string databaseUrl)
    {
        var builder = WebApplication.CreateBuilder(args);
        var connectionString = Migrations.ConnectionString(databaseUrl);

        builder.AddServiceDefaults();

        // h2c: gRPC без TLS требует HTTP/2, а plaintext-endpoint без ALPN не умеет
        // договариваться о версии. Протокол задан кодом, а не appsettings.json,
        // потому что без него транспорт не работает вовсе. Форма повторяет Meetups.
        builder.WebHost.ConfigureKestrel(options =>
            options.ConfigureEndpointDefaults(endpoint => endpoint.Protocols = HttpProtocols.Http2));

        // Единственный провайдер Orleans, который берёт скелет. Grain storage и
        // reminders сознательно не регистрируются: источник истины остаётся в
        // PostgreSQL (ADR-029), напоминания и sweeper — PER-222. Отсутствие
        // grain storage работает гейтом: [PersistentState] роняет первую активацию
        // грина, а не старт силоса, поэтому ловит его тест, а не проба готовности.
        builder.UseOrleans(silo =>
        {
            silo.Configure<ClusterOptions>(options =>
            {
                options.ClusterId = ClusterId;
                options.ServiceId = ServiceId;
            });

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
        });

        // В отличие от Meetups хост НЕ поднимается без базы, и это не упущение:
        // membership силоса лежит в PostgreSQL, поэтому силос без базы — не силос.
        // Источник соединений при этом остаётся ленивым, как у соседа.
        //
        // Регистрируется фабрикой, а не готовым экземпляром, и это не стиль:
        // контейнер утилизирует только то, что создал сам, поэтому переданный
        // ему извне NpgsqlDataSource пережил бы остановку хоста вместе со своим
        // пулом соединений. Meetups регистрирует свой источник тем же способом.
        builder.Services.AddSingleton(_ => NpgsqlDataSource.Create(connectionString));
        builder.Services.AddSingleton<GrainActivationStore>();

        // Сам gRPC-стек. Реализаций сервиса пока нет (PER-71), но без него не
        // поднимаются ни проба, ни рефлексия: обе маппятся как gRPC-сервисы.
        builder.Services.AddGrpc();

        // Мост из health checks, зарегистрированных ServiceDefaults, в grpc.health.v1.
        // Источником состояния остаётся ServiceDefaults, gRPC — только его витрина.
        builder.Services.AddGrpcHealthChecks();

        // Reflection включён безусловно, как в Identity и Meetups: иначе каждая
        // ручная проверка grpcurl требует -import-path и -proto.
        builder.Services.AddGrpcReflection();

        var app = builder.Build();

        app.MapGrpcHealthChecksService();
        app.MapGrpcReflectionService();

        // Реализаций gRPC-сервиса здесь нет: command plane — PER-71. Endpoint
        // существует, чтобы проба готовности и рефлексия отвечали уже сейчас.
        return app;
    }
}
