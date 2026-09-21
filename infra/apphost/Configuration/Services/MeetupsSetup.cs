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
            .WithGrpcHealthProbe(AppHostNames.Endpoints.Grpc)
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
            // Часовой пояс сообщества — продуктовое значение, а не секрет, и в MVP
            // он один: сходки сообщества живут по московскому времени. По нему
            // решается, когда сходка переходит в архив, и в этом поясе
            // интерпретируется момент назначенной публикации; без него
            // `Host.build` падает на старте, а не на первом запросе. Локальному
            // прогону значение даёт AppHost; production-топология назовёт своё.
            .WithEnvironment("MEETUPS_COMMUNITY_TIME_ZONE", "Europe/Moscow");
    }
}
