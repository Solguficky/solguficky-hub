using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class TelegramBotSetup
{
    public static IResourceBuilder<IResourceWithEnvironment> Configure(ServiceGraphContext context)
    {
        var environment = TelegramEnvironment.Resolve(context.Builder.Configuration);

        // Секрет объявляется только когда профиль владеет ботом: профиль без него
        // не спрашивает токен и не требует Node-toolchain. Имя параметра приходит
        // от среды, поэтому прогон спрашивает ровно один токен — тот, которым
        // ходит в выбранный Telegram.
        var token = context.Builder.AddParameter(environment.TokenParameter, secret: true);

        return context.Builder
            .AddJavaScriptApp(
                AppHostNames.Resources.TelegramBot,
                RepositoryPaths.App(context.Builder, "telegram-bot"),
                "start")
            .WithEnvironment("TELEGRAM_BOT_TOKEN", token)
            .WithEnvironment("TELEGRAM_BOT_ENVIRONMENT", environment.Value)
            .BindEndpoint(context, AppHostNames.Resources.Identity, "grpc", "IDENTITY_GRPC_URL")
            .BindEndpoint(context, AppHostNames.Resources.Meetups, "grpc", "MEETUPS_GRPC_URL");
    }
}
