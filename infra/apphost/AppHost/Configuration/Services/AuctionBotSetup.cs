using AppHost.Configuration.Extensions;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;
using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Бот аукциона: поверхность аукциона пакета <c>apps/hub-bot</c> отдельным
/// процессом со своим токеном и своим поллером (ADR-064, п. 18). Переменные у
/// двух ботов общие, значения свои: остановка одного поллера второй не трогает.
/// Maintainer-секрета у него нет.
/// </summary>
internal static class AuctionBotSetup
{
    // Форма бота хаба: ни порта, ни health, поэтому проб нет и остаётся рестарт
    // по выходу (HubBotSetup). Образ — тоже его.
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
            SupportBotLink.Local(configuration),
            BotMediaChannel.Local(configuration),
            BotBuild.Process(context.Builder, AppHostNames.Resources.AuctionBot));
    }

    /// <summary>
    /// В чарте бот своей сборки не имеет: workload берёт образ бота хаба, а
    /// поверхность выбирает переменная (ADR-064, п. 18). Имя образа здесь —
    /// заглушка: шаблон пода читает ключ образа бота хаба
    /// (<see cref="ClusterWorkload.ImageOf"/>). Значения токенов при публикации
    /// неизвестны, поэтому <see cref="RequireOwnToken"/> здесь не зовётся: в
    /// среде повтор токена бота хаба ловит её выкладка до старта подов.
    /// </summary>
    public static IResourceBuilder<ContainerResource> Publish(ServiceGraphContext context) =>
        Wire(
                context,
                TelegramEnvironment.Production,
                SupportBotLink.Published(context.Builder),
                BotMediaChannel.Published(context.Builder),
                context.Builder.AddContainer(AppHostNames.Resources.AuctionBot, AppHostNames.Resources.HubBot))
            .AsClusterWorkload(Cluster);

    private static IResourceBuilder<T> Wire<T>(
        ServiceGraphContext context,
        TelegramEnvironment environment,
        SupportBotLink? support,
        BotMediaChannel? media,
        IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment, IResourceWithWaitSupport
    {
        // Вход в бот поддержки из ожидания допуска и «Задать вопрос ↗» FAQ
        // (ADR-068, п. 2).
        support?.UsernameAndQuestionUrl(bot);

        // Гостю объявление со своим фото доставляет этот бот копией поста того
        // же канала, что у бота хаба (дополнение ADR-057 от 2026-10-27).
        media?.ChannelId(bot);

        var token = context.Builder.AddParameter(environment.AuctionBotTokenParameter, secret: true);

        return bot
            .WithEnvironment("BOT_SURFACE", "auction")
            .WithEnvironment("BOT_TOKEN", token)
            // Не путать с токеном Bot API выше: этим бот доказывает себя
            // Identity, Auction и Notifications (ADR-056).
            .WithServiceToken(context, HubBotSetup.BotServiceTokenVariable)
            .WithEnvironment("BOT_ENVIRONMENT", environment.Value)
            .WithEnvironment("BOT_COMMUNITY_TIME_ZONE", CommunityTime.Zone)
            .BindEndpoint(context, AppHostNames.Resources.Identity, AppHostNames.Endpoints.Grpc, "IDENTITY_GRPC_URL")
            .BindEndpoint(context, AppHostNames.Resources.Auction, AppHostNames.Endpoints.Grpc, "AUCTION_GRPC_URL")
            // Настройка «перебили» (PER-515) и избранные лоты (PER-495, ADR-063).
            // Без узла Notifications привязки нет, и бот живёт без настройки и
            // без избранного.
            .BindEndpoint(context, AppHostNames.Resources.Notifications, AppHostNames.Endpoints.Grpc, "NOTIFICATIONS_GRPC_URL")
            // Второй вход бота — адресные факты аукциона из шины (PER-328).
            // WaitFor(nats) внутри BindConnection ждёт и применения топологии:
            // durable и bucket журнала заводит AppHost, а бот без них не стартует.
            .BindConnection<T, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.Nats,
                "BOT_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"));
    }

    /// <summary>
    /// Отсутствующий токен или токен бота хаба останавливают сборку графа до
    /// старта поллеров (ADR-044). Пустой параметр Aspire спросил бы в дашборде
    /// уже после старта остальных ресурсов, а повтор токена Telegram показал бы
    /// только конфликтом polling у обоих ботов (<see cref="BotTokens"/>).
    /// Повтор токена бота поддержки ловит сам бот поддержки.
    /// </summary>
    internal static void RequireOwnToken(IConfiguration configuration, TelegramEnvironment environment)
    {
        var name = environment.AuctionBotTokenParameter;
        var value = BotTokens.Value(configuration, name) ?? throw new InvalidOperationException(
            $"Parameter '{name}' of '{AppHostNames.Resources.AuctionBot}' is not set. " +
            $"Set it with `dotnet user-secrets set Parameters:{name} <token>` in infra/apphost/AppHost.");

        BotTokens.RequireDistinct(
            configuration,
            AppHostNames.Resources.AuctionBot,
            name,
            value,
            TelegramEnvironment.HubBotTokenParameters);
    }
}
