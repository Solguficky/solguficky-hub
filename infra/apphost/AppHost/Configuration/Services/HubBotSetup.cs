using AppHost.Configuration.Extensions;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class HubBotSetup
{
    /// <summary>
    /// Имя бота аукциона без «@» (PER-441): экран каналов прихода собирает по
    /// нему вторую ссылку <c>s_&lt;код&gt;</c>. Бот хаба не знает его сам — getMe
    /// по чужому токену дал бы ему чужой секрет. Не секрет и не параметр Aspire,
    /// как <see cref="AuctionBotSetup.AuctionIdKey"/>: без значения экран отдаёт
    /// только ссылку в бот хаба. Задаётся user-secrets AppHost или переменной
    /// <c>HubBot__AuctionBotUsername</c>.
    /// </summary>
    internal const string AuctionBotUsernameKey = "HubBot:AuctionBotUsername";

    // Проб нет: у бота нет ни порта, ни health-эндпоинта, а exec-проба «процесс
    // жив» дала бы сигнал, которому нельзя верить. Остаётся рестарт по выходу.
    private static readonly ClusterWorkload Cluster = new(
        RunAsUser: 1000,
        CpuRequest: "50m",
        MemoryRequest: "128Mi",
        CpuLimit: "500m",
        MemoryLimit: "256Mi",
        Probe: null);

    public static IResourceBuilder<IResourceWithEnvironment> Configure(ServiceGraphContext context) =>
        Wire(
            context,
            TelegramEnvironment.Resolve(context.Builder.Configuration),
            context.Builder.AddJavaScriptApp(
                AppHostNames.Resources.HubBot,
                RepositoryPaths.App(context.Builder, "hub-bot"),
                "start"));

    /// <summary>
    /// В чарте бот — образ по его Containerfile из корня репозитория, а не
    /// контейнер, который Aspire сгенерировал бы из <c>AddJavaScriptApp</c> сам:
    /// кодогенерации бота нужен <c>contracts/proto</c> (ADR-055).
    /// </summary>
    public static IResourceBuilder<ContainerResource> Publish(ServiceGraphContext context) =>
        Wire(
                context,
                TelegramEnvironment.Production,
                context.Builder.AddDockerfile(
                    AppHostNames.Resources.HubBot,
                    RepositoryPaths.Root(context.Builder),
                    "apps/hub-bot/Containerfile"))
            .AsClusterWorkload(Cluster);

    private static IResourceBuilder<T> Wire<T>(
        ServiceGraphContext context,
        TelegramEnvironment environment,
        IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment, IResourceWithWaitSupport
    {
        // Секрет объявляется только когда профиль владеет ботом: профиль без него
        // не спрашивает токен и не требует Node-toolchain. Имя параметра приходит
        // от среды, поэтому прогон спрашивает ровно один токен — тот, которым
        // ходит в выбранный Telegram.
        var token = context.Builder.AddParameter(environment.TokenParameter, secret: true);

        // Форму значения проверяет сам бот на старте: AppHost передаёт его как есть.
        var auctionBotUsername = context.Builder.Configuration[AuctionBotUsernameKey]?.Trim();
        if (!string.IsNullOrEmpty(auctionBotUsername))
        {
            bot.WithEnvironment("HUB_BOT_AUCTION_BOT_USERNAME", auctionBotUsername);
        }

        return bot
            .WithEnvironment("HUB_BOT_TOKEN", token)
            // Не путать с токеном Bot API выше: этим бот доказывает себя
            // Identity, Meetups и Notifications (ADR-056).
            .WithServiceToken(context)
            .WithEnvironment("HUB_BOT_ENVIRONMENT", environment.Value)
            // Бот показывает назначенный момент публикации в поясе сообщества,
            // а Meetups отдаёт его мгновением UTC. Значение общее с Meetups
            // (CommunityTime): разные пояса у двух сервисов дали бы карточку,
            // которая врёт о времени публикации на разницу поясов.
            .WithEnvironment("HUB_BOT_COMMUNITY_TIME_ZONE", CommunityTime.Zone)
            .BindEndpoint(context, AppHostNames.Resources.Identity, "grpc", "IDENTITY_GRPC_URL")
            .BindEndpoint(context, AppHostNames.Resources.Meetups, "grpc", "MEETUPS_GRPC_URL")
            .BindEndpoint(context, AppHostNames.Resources.Notifications, "grpc", "NOTIFICATIONS_GRPC_URL")
            // Второй вход бота — адресные факты Notifications. WaitFor(nats)
            // внутри BindConnection ждёт и применения топологии: durable и
            // bucket журнала заводит AppHost, а бот без них не стартует.
            .BindConnection<T, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.Nats,
                "HUB_BOT_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"));
    }
}
