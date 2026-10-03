namespace AppHost.Configuration.Infrastructure;

/// <summary>
/// Строка подключения к базе в формате, который читает компонент. Локально она
/// собирается из свойств контейнера с выключенным TLS: контейнер Aspire его не
/// поднимает. В чарте база — строка подключения среды (<c>AddConnectionString</c>),
/// и её значение ops-репозиторий кладёт целиком, уже в формате компонента и с
/// режимом TLS своего кластера; AppHost её не дописывает. Выбор делается по типу
/// ресурса, а не по режиму: setup режим не спрашивает.
/// </summary>
internal static class PostgresConnection
{
    /// <summary>URI для клиентов вроде pgx, которые формат ключей Npgsql не понимают (Identity).</summary>
    public static ReferenceExpression Uri(IResourceBuilder<IResourceWithConnectionString> database) =>
        database.Resource is PostgresDatabaseResource local
            ? ReferenceExpression.Create($"{local.UriExpression}?sslmode=disable")
            : ReferenceExpression.Create($"{database.Resource.ConnectionStringExpression}");

    /// <summary>Строка ключей Npgsql для .NET-сервисов (Meetups, Notifications).</summary>
    public static ReferenceExpression Npgsql(IResourceBuilder<IResourceWithConnectionString> database) =>
        database.Resource is PostgresDatabaseResource local
            ? ReferenceExpression.Create($"{local.ConnectionStringExpression};SSL Mode=Disable")
            : ReferenceExpression.Create($"{database.Resource.ConnectionStringExpression}");

    /// <summary>
    /// JDBC URL без учётных данных для Pekko Persistence JDBC (Auction): пользователь
    /// и пароль идут сервису отдельными ключами, поэтому в строке среды их нет.
    /// Локальный URL без sslmode: pgjdbc по умолчанию TLS только предлагает и к
    /// контейнеру Aspire без него подключается.
    /// </summary>
    public static ReferenceExpression Jdbc(IResourceBuilder<IResourceWithConnectionString> database) =>
        database.Resource is PostgresDatabaseResource local
            ? ReferenceExpression.Create($"{local.JdbcConnectionString}")
            : ReferenceExpression.Create($"{database.Resource.ConnectionStringExpression}");
}
