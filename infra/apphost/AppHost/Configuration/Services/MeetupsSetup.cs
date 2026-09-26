using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class MeetupsSetup
{
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
            .BindConnection<ProjectResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.MeetupsDb,
                "MEETUPS_DATABASE_URL",
                database => ReferenceExpression.Create(
                    $"{database.Resource.ConnectionStringExpression};SSL Mode=Disable"))
            // По поясу сообщества решается, когда сходка переходит в архив, и в
            // нём интерпретируется момент назначенной публикации; без него
            // `Host.build` падает на старте, а не на первом запросе. Значение
            // общее с ботом (CommunityTime).
            .WithEnvironment("MEETUPS_COMMUNITY_TIME_ZONE", CommunityTime.Zone)
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
            .BindConnection<ProjectResource, NatsServerResource>(
                context,
                AppHostNames.Resources.Nats,
                "MEETUPS_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"));
    }
}
