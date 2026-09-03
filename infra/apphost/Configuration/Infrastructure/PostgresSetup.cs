using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Infrastructure;

internal static class PostgresSetup
{
    public static IResourceBuilder<PostgresServerResource> Configure(ServiceGraphContext context)
    {
        var postgres = context.Builder
            .AddPostgres(AppHostNames.Resources.Postgres)
            .WithImageTag("16-alpine")
            .WithDataVolume("solguficky-postgres-data");

        // База принадлежит серверу, а не профилю: её жизненный цикл задаёт этот
        // setup, поэтому в графе она появляется через Publish, а не через AddInfrastructure.
        context.Publish(
            AppHostNames.Resources.SolgufickyDb,
            postgres.AddDatabase(AppHostNames.Resources.SolgufickyDb));

        return postgres;
    }
}
