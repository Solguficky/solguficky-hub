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
    // по выходу (HubBotSetup).
    private static readonly ClusterWorkload Cluster = new(
        RunAsUser: 1000,
        CpuRequest: "50m",
        MemoryRequest: "128Mi",
        CpuLimit: "500m",
        MemoryLimit: "256Mi",
        Probe: null);

    public static IResourceBuilder<IResourceWithEnvironment> Configure(ServiceGraphContext context)
    {
        var configuration = context.Builder.Configuration;
        var environment = TelegramEnvironment.Resolve(configuration);
        RequireOwnToken(configuration, environment);

        return Wire(
            context,
            environment,
            BotBuild.Process(context.Builder, AppHostNames.Resources.AuctionBot));
    }

    /// <summary>
    /// В чарте бот — образ по Containerfile пакета ботов из корня репозитория,
    /// как бот хаба (ADR-055): образ тот же, поверхность выбирает переменная. Значения токенов при публикации неизвестны, поэтому
    /// <see cref="RequireOwnToken"/> здесь не зовётся: в среде повтор токена
    /// бота хаба ловит её выкладка до старта подов.
    /// </summary>
    public static IResourceBuilder<ContainerResource> Publish(ServiceGraphContext context) =>
        Wire(
                context,
                TelegramEnvironment.Production,
                context.Builder.AddDockerfile(
                    AppHostNames.Resources.AuctionBot,
                    RepositoryPaths.Root(context.Builder),
                    "apps/hub-bot/Containerfile"))
            .AsClusterWorkload(Cluster);

    private static IResourceBuilder<T> Wire<T>(
        ServiceGraphContext context,
        TelegramEnvironment environment,
        IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment, IResourceWithWaitSupport
    {
        var token = context.Builder.AddParameter(environment.AuctionBotTokenParameter, secret: true);

        return bot
            .WithEnvironment("BOT_SURFACE", "auction")
            .WithEnvironment("BOT_TOKEN", token)
            // Не путать с токеном Bot API выше: этим бот доказывает себя
            // Identity и Auction (ADR-056).
            .WithServiceToken(context, HubBotSetup.BotServiceTokenVariable)
            .WithEnvironment("BOT_ENVIRONMENT", environment.Value)
            .WithEnvironment("BOT_COMMUNITY_TIME_ZONE", CommunityTime.Zone)
            .BindEndpoint(context, AppHostNames.Resources.Identity, AppHostNames.Endpoints.Grpc, "IDENTITY_GRPC_URL")
            .BindEndpoint(context, AppHostNames.Resources.Auction, AppHostNames.Endpoints.Grpc, "AUCTION_GRPC_URL")
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
    /// только конфликтом polling у обоих ботов.
    ///
    /// Сравнение идёт со значениями из конфигурации в любом профиле, а не только
    /// в графе, который владеет обоими ботами: user-secrets AppHost общие, и
    /// профиль <c>auction-bot</c>, поднятый рядом с <c>hub</c>, иначе повтора
    /// не увидел бы. Параметр бота хаба при этом не объявляется. Причина отказа
    /// называет параметры, но не значения: токен — секрет.
    /// </summary>
    internal static void RequireOwnToken(IConfiguration configuration, TelegramEnvironment environment)
    {
        var name = environment.AuctionBotTokenParameter;
        var value = configuration[$"Parameters:{name}"]?.Trim();
        if (string.IsNullOrEmpty(value))
        {
            throw new InvalidOperationException(
                $"Parameter '{name}' of '{AppHostNames.Resources.AuctionBot}' is not set. " +
                $"Set it with `dotnet user-secrets set Parameters:{name} <token>` in infra/apphost/AppHost.");
        }

        foreach (var hub in TelegramEnvironment.HubBotTokenParameters)
        {
            if (string.Equals(configuration[$"Parameters:{hub}"]?.Trim(), value, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"Parameter '{name}' of '{AppHostNames.Resources.AuctionBot}' repeats '{hub}'. " +
                    "Each bot needs its own token: two pollers on one token conflict.");
            }
        }
    }
}
