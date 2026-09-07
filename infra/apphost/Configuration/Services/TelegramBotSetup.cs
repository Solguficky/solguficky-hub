using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class TelegramBotSetup
{
    public static IResourceBuilder<IResourceWithEnvironment> Configure(ServiceGraphContext context)
    {
        // Секрет объявляется только когда профиль владеет ботом: профиль без него
        // не спрашивает токен и не требует Node-toolchain.
        var token = context.Builder.AddParameter("telegram-bot-token", secret: true);

        return context.Builder
            .AddJavaScriptApp(
                AppHostNames.Resources.TelegramBot,
                RepositoryPaths.App(context.Builder, "telegram-bot"),
                "start")
            .WithEnvironment("TELEGRAM_BOT_TOKEN", token)
            .BindEndpoint(context, AppHostNames.Resources.Identity, "grpc", "IDENTITY_GRPC_URL");
    }
}
