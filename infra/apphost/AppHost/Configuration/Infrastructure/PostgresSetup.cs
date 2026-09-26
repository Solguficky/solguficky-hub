using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Infrastructure;

internal static class PostgresSetup
{
    public static IResourceBuilder<PostgresServerResource> Configure(ServiceGraphContext context)
    {
        var postgres = context.Builder
            .AddPostgres(AppHostNames.Resources.Postgres)
            .WithImageTag("16-alpine")
            .WithDataVolume(DataVolumes.Name(context.Builder, "postgres-data"));

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

        // Notifications держит в своей базе и доменную схему, и таблицы
        // membership Orleans: и то и другое заводит один DbUp сервиса.
        context.Publish(
            AppHostNames.Resources.NotificationsDb,
            postgres.AddDatabase(AppHostNames.Resources.NotificationsDb, AppHostNames.Resources.NotificationsDbName));

        // Журнал и snapshots Pekko Persistence JDBC лягут в отдельную базу
        // Auction (ADR-045). Схему в ней заведёт сам сервис, когда появится
        // persistence (PER-302); до тех пор база пустая.
        context.Publish(
            AppHostNames.Resources.AuctionDb,
            postgres.AddDatabase(AppHostNames.Resources.AuctionDb, AppHostNames.Resources.AuctionDbName));

        return postgres;
    }
}
