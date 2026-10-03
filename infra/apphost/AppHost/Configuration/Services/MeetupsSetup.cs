using AppHost.Configuration.Extensions;
using AppHost.Configuration.Infrastructure;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class MeetupsSetup
{
    // В чарте порт закреплён, а не взят из values: gRPC-проба Kubernetes
    // принимает только число, и проба с портом из шаблона разошлась бы с ним.
    private const int ContainerGrpcPort = 8080;

    private static readonly ClusterWorkload Cluster = new(
        RunAsUser: 1654,
        CpuRequest: "100m",
        MemoryRequest: "192Mi",
        CpuLimit: "1",
        MemoryLimit: "384Mi",
        Probe: new GrpcProbe(ContainerGrpcPort, AppHostNames.Readiness.Meetups));

    public static IResourceBuilder<ProjectResource> Configure(ServiceGraphContext context)
    {
        // Отдельных узлов кодогенерации и сборки нет: Grpc.Tools генерирует C#
        // внутри `dotnet build`, а сборку проекта Aspire делает сам.
        //
        // Endpoint назван grpc: сервис слушает h2c и HTTP/1.1 не обслуживает,
        // поэтому имя должно отличать его от обычного веб-узла. Ссылка на него
        // в дашборде браузером не открывается — это цена plaintext gRPC, та же,
        // что у Identity.
        return context.Builder
            .AddProject<Projects.Meetups>(AppHostNames.Resources.Meetups)
            .WithHttpEndpoint(name: AppHostNames.Endpoints.Grpc)
            .WithGrpcHealthProbe(AppHostNames.Endpoints.Grpc, AppHostNames.Readiness.Meetups)
            // Meetups — .NET, поэтому берёт готовую строку Npgsql из Aspire, а не
            // URI: `UriExpression` существует для клиентов вроде pgx, которые
            // формат ключей не понимают, и Identity на Go пользуется именно им.
            // Здесь URI пришлось бы разбирать обратно в ключи руками.
            .BindConnection<ProjectResource, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.MeetupsDb,
                "MEETUPS_DATABASE_URL",
                PostgresConnection.Npgsql)
            // По поясу сообщества решается, когда сходка переходит в архив, и в
            // нём интерпретируется момент назначенной публикации; без него
            // `Host.build` падает на старте, а не на первом запросе. Значение
            // общее с ботом (CommunityTime).
            .WithEnvironment("MEETUPS_COMMUNITY_TIME_ZONE", CommunityTime.Zone)
            // Meetups и вызывающий (CheckGlobalRole в Identity), и вызываемый;
            // вызывающие — по колонке Caller в integration.md (ADR-056).
            .WithServiceToken(context)
            .AcceptCallers(context, AppHostNames.Resources.HubBot, AppHostNames.Resources.Notifications)
            // Источник права для CheckMeetupAuthority: роль администратора Meetups
            // спрашивает у Identity сам (ADR-051). Профиль без identity оставляет
            // переменную пустой, и метод честно отвечает UNAVAILABLE — остальные
            // операции Identity не нужны, поэтому профиль `meetups` его не поднимает.
            .BindEndpoint(context, AppHostNames.Resources.Identity, AppHostNames.Endpoints.Grpc, "MEETUPS_IDENTITY_GRPC_URL")
            // Адрес шины для адаптера публикации из журнала. Узла nats в запуске
            // нет — bind молчит, и Meetups поднимается с ненастроенным портом:
            // события копятся в журнале и уйдут, когда адрес появится. WaitFor
            // внутри bind ждёт и применения топологии JetStream (NatsSetup), поэтому
            // первая публикация не встречает отсутствующий стрим.
            .BindConnection<ProjectResource, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.Nats,
                "MEETUPS_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"));
    }

    /// <summary>
    /// В чарте — тот же проект: образ собирает SDK-контейнер по Container.targets,
    /// тем же путём, что CI и <c>aspire do push</c> (ADR-055).
    /// </summary>
    public static IResourceBuilder<ProjectResource> Publish(ServiceGraphContext context) =>
        Configure(context)
            .WithEndpoint(AppHostNames.Endpoints.Grpc, endpoint => endpoint.TargetPort = ContainerGrpcPort)
            .AsClusterWorkload(Cluster);
}
