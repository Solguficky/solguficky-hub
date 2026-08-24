using Microsoft.Extensions.Configuration;

/// <summary>
/// Режим запуска одного компонента: Local (AddProject/AddExecutable из исходников),
/// Container (AddDockerfile), Off (не поднимать — владелец запускает сам).
/// </summary>
public enum ComponentMode
{
    Local,
    Container,
    Off,
}

/// <summary>
/// Резолвит режим компонента: явный <c>Topology:{component}</c> (env <c>TOPOLOGY__{component}</c>)
/// переопределяет профильный дефолт, ничего не переопределяет код AppHost.
/// </summary>
public static class Topology
{
    private static readonly string[] KnownProfiles = ["infra", "core", "full"];

    /// <summary>
    /// Компоненты первого вертикального среза: в профиле <c>core</c> поднимаются
    /// из исходников, остальные — выключены. Пополняется вместе с регистрацией
    /// компонента в <c>Program.cs</c>.
    /// </summary>
    private static readonly HashSet<string> CoreComponents = [];

    public static string ResolveProfile(IConfiguration config)
    {
        var profile = (config["Topology:Profile"] ?? "core").ToLowerInvariant();

        if (!KnownProfiles.Contains(profile))
        {
            throw new InvalidOperationException(
                $"Неизвестный профиль топологии '{profile}'. Ожидались: {string.Join(", ", KnownProfiles)}.");
        }

        return profile;
    }

    public static ComponentMode ResolveMode(IConfiguration config, string profile, string component)
    {
        var raw = config[$"Topology:{component}"];
        if (!string.IsNullOrWhiteSpace(raw))
        {
            return Enum.Parse<ComponentMode>(raw, ignoreCase: true);
        }

        return ProfileDefault(profile, component);
    }

    private static ComponentMode ProfileDefault(string profile, string component) => profile switch
    {
        "infra" => ComponentMode.Off,
        "core" => CoreComponents.Contains(component) ? ComponentMode.Local : ComponentMode.Off,
        "full" => ComponentMode.Local,
        _ => throw new InvalidOperationException(
            $"Неизвестный профиль топологии '{profile}'. Ожидались: {string.Join(", ", KnownProfiles)}."),
    };
}
