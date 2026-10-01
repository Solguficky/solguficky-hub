using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;
using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Бот аукциона (ADR-044): отдельный процесс со своим токеном и своим поллером.
/// Ни одной переменной бота хаба он не получает, и бот хаба — его: остановка
/// одного поллера второй не трогает. Maintainer-секрета у него нет.
/// </summary>
internal static class AuctionBotSetup
{
    public static IResourceBuilder<IResourceWithEnvironment> Configure(ServiceGraphContext context)
    {
        var configuration = context.Builder.Configuration;
        var environment = TelegramEnvironment.Resolve(configuration);
        RequireOwnToken(configuration, environment);

        var token = context.Builder.AddParameter(environment.AuctionBotTokenParameter, secret: true);

        return context.Builder
            .AddJavaScriptApp(
                AppHostNames.Resources.AuctionBot,
                RepositoryPaths.App(context.Builder, "auction-bot"),
                "start")
            .WithEnvironment("AUCTION_BOT_TOKEN", token)
            // Не путать с токеном Bot API выше: этим бот доказывает себя
            // Identity и Auction (ADR-056).
            .WithServiceToken(context)
            .WithEnvironment("AUCTION_BOT_ENVIRONMENT", environment.Value)
            .BindEndpoint(context, AppHostNames.Resources.Identity, AppHostNames.Endpoints.Grpc, "IDENTITY_GRPC_URL")
            .BindEndpoint(context, AppHostNames.Resources.Auction, AppHostNames.Endpoints.Grpc, "AUCTION_GRPC_URL");
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
