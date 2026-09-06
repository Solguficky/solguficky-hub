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
            .BindConnection<ProjectResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.SolgufickyDb,
                "MEETUPS_DATABASE_URL",
                database => ReferenceExpression.Create($"{database.Resource.UriExpression}?sslmode=disable"));
    }
}
