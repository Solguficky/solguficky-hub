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
    public static string ResolveProfile(IConfiguration config) =>
        config["Topology:Profile"] ?? "core";

    public static ComponentMode ResolveMode(IConfiguration config, string profile, string component)
    {
        var raw = config[$"Topology:{component}"];
        if (!string.IsNullOrWhiteSpace(raw))
        {
            return Enum.Parse<ComponentMode>(raw, ignoreCase: true);
        }

        return ProfileDefault(profile, component);
    }

    private static ComponentMode ProfileDefault(string profile, string component) => profile.ToLowerInvariant() switch
    {
        "infra" => ComponentMode.Off,
        "core" => component is "AuctionService" or "TelegramGateway" ? ComponentMode.Local : ComponentMode.Off,
        "full" => ComponentMode.Local,
        _ => throw new InvalidOperationException(
            $"Неизвестный профиль топологии '{profile}'. Ожидались: infra, core, full."),
    };
}
