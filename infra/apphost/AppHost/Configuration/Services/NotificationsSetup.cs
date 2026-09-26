using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class NotificationsSetup
{
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
            .WithGrpcHealthProbe(AppHostNames.Endpoints.Grpc)
            // В этом поясе реплика хранит расписание, и в нём же момент начала
            // становится мгновением, от которого считается напоминание.
            .WithEnvironment("NOTIFICATIONS_COMMUNITY_TIME_ZONE", CommunityTime.Zone)
            // Notifications — .NET, поэтому берёт готовую строку Npgsql, как Meetups.
            // Миграции применяет сам сервис при старте, до подъёма силоса: таблицы
            // membership Orleans заводит тот же DbUp.
            .BindConnection<ProjectResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.NotificationsDb,
                "NOTIFICATIONS_DATABASE_URL",
                database => ReferenceExpression.Create(
                    $"{database.Resource.ConnectionStringExpression};SSL Mode=Disable"))
            // Шина реплики чужих фактов. WaitFor(nats) внутри BindConnection ждёт
            // и применения топологии: сервис стартует, когда его durable уже
            // заведены, а сам он их не заводит и без них падает.
            .BindConnection<ProjectResource, NatsServerResource>(
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
}
