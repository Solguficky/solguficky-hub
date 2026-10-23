using AppHost.Configuration.Extensions;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;
using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Бот поддержки: поверхность поддержки пакета <c>apps/hub-bot</c> отдельным
/// процессом со своим токеном и своим поллером (ADR-068, п. 1). Зовёт он одну
/// Identity — <c>ResolveIdentity</c> ради блокировки и круга в карточке темы,
/// п. 3, — а пару «человек ↔ тема» держит в bucket'е шины, п. 8. Meetups,
/// Notifications и Auction ему не нужны. Maintainer-секрета у него нет.
/// </summary>
internal static class SupportBotSetup
{
    // Форма бота аукциона: ни порта, ни health, поэтому проб нет и остаётся
    // рестарт по выходу (HubBotSetup). Образ — бота хаба. Урезанную память
    // среды кладут её values (stage — 80Mi лимита под квоту).
    private static readonly ClusterWorkload Cluster = new(
        RunAsUser: 1000,
        CpuRequest: "50m",
        MemoryRequest: "128Mi",
        CpuLimit: "500m",
        MemoryLimit: "256Mi",
        Probe: null,
        ImageOf: AppHostNames.Resources.HubBot);

    public static IResourceBuilder<IResourceWithEnvironment> Configure(ServiceGraphContext context)
    {
        var configuration = context.Builder.Configuration;
        var environment = TelegramEnvironment.Resolve(configuration);
        RequireOwnToken(configuration, environment);

        return Wire(
            context,
            environment,
            BotBuild.Process(context.Builder, AppHostNames.Resources.SupportBot));
    }

    /// <summary>
    /// В чарте бот своей сборки не имеет: workload берёт образ бота хаба, а
    /// поверхность выбирает переменная (ADR-064, п. 18). Повтор токена в среде
    /// ловит её выкладка до старта подов: значений при публикации нет.
    /// </summary>
    public static IResourceBuilder<ContainerResource> Publish(ServiceGraphContext context) =>
        Wire(
                context,
                TelegramEnvironment.Production,
                context.Builder.AddContainer(AppHostNames.Resources.SupportBot, AppHostNames.Resources.HubBot))
            .AsClusterWorkload(Cluster);

    private static IResourceBuilder<T> Wire<T>(
        ServiceGraphContext context,
        TelegramEnvironment environment,
        IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment, IResourceWithWaitSupport
    {
        var token = context.Builder.AddParameter(environment.SupportBotTokenParameter, secret: true);

        // Супергруппа операторов с темами (ADR-068, п. 4) — своя у каждой среды,
        // поэтому параметр без значения: локально его спросит дашборд, как токен,
        // а в чарте кладут values среды. Не секрет: id группы без членства в ней
        // переписки не открывает. Форму значения проверяет сам бот на старте.
        var group = context.Builder.AddParameter(environment.SupportGroupParameter);

        return bot
            .WithEnvironment("BOT_SURFACE", "support")
            .WithEnvironment("BOT_TOKEN", token)
            // Не путать с токеном Bot API выше: этим бот доказывает себя
            // Identity (ADR-056).
            .WithServiceToken(context, HubBotSetup.BotServiceTokenVariable)
            .WithEnvironment("BOT_ENVIRONMENT", environment.Value)
            .WithEnvironment("BOT_COMMUNITY_TIME_ZONE", CommunityTime.Zone)
            .WithEnvironment("BOT_SUPPORT_GROUP_ID", group)
            .BindEndpoint(context, AppHostNames.Resources.Identity, AppHostNames.Endpoints.Grpc, "IDENTITY_GRPC_URL")
            // Вход процесса из шины — bucket пар `support-bot-topics`. WaitFor(nats)
            // внутри BindConnection ждёт и применения топологии: bucket заводит
            // AppHost, а бот без него не стартует.
            .BindConnection<T, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.Nats,
                "BOT_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"));
    }

    /// <summary>
    /// Токен бота хаба или бота аукциона останавливает сборку графа до старта
    /// поллеров (<see cref="BotTokens"/>). Пустой токен — нет: узел живёт и в
    /// профиле <c>hub</c>, умолчании <c>aspire run</c>, и пустой параметр там
    /// спрашивает дашборд, как токен бота хаба, а не роняет запуск тем, кому
    /// бот поддержки не нужен. Повтор пустого значения невозможен.
    /// </summary>
    internal static void RequireOwnToken(IConfiguration configuration, TelegramEnvironment environment)
    {
        var name = environment.SupportBotTokenParameter;
        var value = BotTokens.Value(configuration, name);
        if (value is null)
        {
            return;
        }

        BotTokens.RequireDistinct(
            configuration,
            AppHostNames.Resources.SupportBot,
            name,
            value,
            TelegramEnvironment.HubBotTokenParameters.Concat(TelegramEnvironment.AuctionBotTokenParameters));
    }
}
