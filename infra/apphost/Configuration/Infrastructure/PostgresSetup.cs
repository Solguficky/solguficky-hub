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

        // Базы принадлежат серверу, а не профилю: их жизненный цикл задаёт этот
        // setup, поэтому в графе они появляются через Publish, а не через AddInfrastructure.
        // Одна база на сервис: владелец схемы один, и чужой сервис не может ни
        // прочитать её таблицы, ни столкнуться с ними именами.
        context.Publish(
            AppHostNames.Resources.IdentityDb,
            postgres.AddDatabase(AppHostNames.Resources.IdentityDb, AppHostNames.Resources.IdentityDbName));

        context.Publish(
            AppHostNames.Resources.MeetupsDb,
            postgres.AddDatabase(AppHostNames.Resources.MeetupsDb, AppHostNames.Resources.MeetupsDbName));

        return postgres;
    }
}
