namespace AppHost.Configuration;

/// <summary>
/// Пути компонентов от корня репозитория. Aspire запускает AppHost из его
/// каталога, а команды компонентов совпадают с ручным запуском, поэтому
/// working directory считается один раз и здесь.
/// </summary>
internal static class RepositoryPaths
{
    public static string Root(IDistributedApplicationBuilder builder) =>
        Path.GetFullPath(Path.Combine(builder.AppHostDirectory, "../.."));

    public static string App(IDistributedApplicationBuilder builder, string name) =>
        Path.Combine(Root(builder), "apps", name);
}
