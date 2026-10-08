using AppHost.Configuration.Extensions;
using AppHost.Configuration.Infrastructure;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class NotificationsSetup
{
    // В чарте порт закреплён, а не взят из values: gRPC-проба Kubernetes
    // принимает только число, и проба с портом из шаблона разошлась бы с ним.
    private const int ContainerGrpcPort = 8080;

    private static readonly ClusterWorkload Cluster = new(
        RunAsUser: 1654,
        CpuRequest: "100m",
        MemoryRequest: "256Mi",
        CpuLimit: "1",
        MemoryLimit: "512Mi",
        Probe: new GrpcProbe(ContainerGrpcPort, AppHostNames.Readiness.Notifications));

    public static IResourceBuilder<ProjectResource> Configure(ServiceGraphContext context)
    {
        // Форма повторяет MeetupsSetup: тот же h2c-endpoint и та же проба по
        // grpc.health.v1: command plane подписок, настроек и рассылок слушает h2c.
        //
        // Портов силоса Orleans здесь нет намеренно: они штатные, а переопределяет
        // их только тот, кто поднимает второй силос на той же машине.
        return context.Builder
            .AddProject<Projects.Notifications>(AppHostNames.Resources.Notifications)
            .WithHttpEndpoint(name: AppHostNames.Endpoints.Grpc)
            .WithGrpcHealthProbe(AppHostNames.Endpoints.Grpc, AppHostNames.Readiness.Notifications)
            // В этом поясе реплика хранит расписание, и в нём же момент начала
            // становится мгновением, от которого считается напоминание.
            .WithEnvironment("NOTIFICATIONS_COMMUNITY_TIME_ZONE", CommunityTime.Zone)
            // Notifications вызывает Meetups и Identity и принимает обоих ботов
            // (ADR-056): бот аукциона — избранные лоты (ADR-063).
            .WithServiceToken(context)
            .AcceptCallers(context, AppHostNames.Resources.HubBot, AppHostNames.Resources.AuctionBot)
            // Notifications — .NET, поэтому берёт готовую строку Npgsql, как Meetups.
            // Миграции применяет сам сервис при старте, до подъёма силоса: таблицы
            // membership Orleans заводит тот же DbUp.
            .BindConnection<ProjectResource, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.NotificationsDb,
                "NOTIFICATIONS_DATABASE_URL",
                PostgresConnection.Npgsql)
            // Шина реплики чужих фактов. WaitFor(nats) внутри BindConnection ждёт
            // и применения топологии: сервис стартует, когда его durable уже
            // заведены, а сам он их не заводит и без них падает.
            .BindConnection<ProjectResource, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.Nats,
                "NOTIFICATIONS_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"))
            // Владельцы права на ручную рассылку: по сходке отвечает Meetups, на
            // объявление сообществу — Identity (ADR-028 §7, ADR-051). Профиль
            // `notifications` соседей не поднимает, bind молчит, и обе рассылки
            // честно отвечают UNAVAILABLE — остальному сервису они не нужны.
            .BindEndpoint(context, AppHostNames.Resources.Meetups, AppHostNames.Endpoints.Grpc, "NOTIFICATIONS_MEETUPS_GRPC_URL")
            .BindEndpoint(context, AppHostNames.Resources.Identity, AppHostNames.Endpoints.Grpc, "NOTIFICATIONS_IDENTITY_GRPC_URL")
            .BindEndpoint(
                context,
                AppHostNames.Resources.Loki,
                AppHostNames.Endpoints.Http,
                "NOTIFICATIONS_LOKI_OTLP_ENDPOINT");
    }

    /// <summary>
    /// В чарте — тот же проект: образ собирает SDK-контейнер по Container.targets,
    /// тем же путём, что CI и <c>aspire do push</c> (ADR-055).
    /// </summary>
    public static IResourceBuilder<ProjectResource> Publish(ServiceGraphContext context)
    {
        var notifications = Configure(context)
            .WithEndpoint(AppHostNames.Endpoints.Grpc, endpoint => endpoint.TargetPort = ContainerGrpcPort);

        // Силос в поде (PER-387) объявляет себя постоянным адресом Service, а не
        // адресом пода: новый под после Recreate закрывает запись membership
        // предшественника, только если объявляет тот же адрес. В чарте host
        // endpoint'а и есть имя Service. ClusterId и ServiceId — свои у каждой
        // среды, поэтому параметры без значения: их кладут values среды, а пустое
        // значение роняет силос с именем переменной, а не поднимает с чужим.
        var grpc = notifications.GetEndpoint(AppHostNames.Endpoints.Grpc);
        var clusterId = context.Builder.AddParameter("notifications-cluster-id");
        var serviceId = context.Builder.AddParameter("notifications-service-id");

        return notifications
            .WithEnvironment("NOTIFICATIONS_SILO_ADVERTISED_HOST", ReferenceExpression.Create($"{grpc.Property(EndpointProperty.Host)}"))
            .WithEnvironment("NOTIFICATIONS_CLUSTER_ID", clusterId)
            .WithEnvironment("NOTIFICATIONS_SERVICE_ID", serviceId)
            .ExportsTelemetryToCollector()
            .AsClusterWorkload(Cluster);
    }
}
