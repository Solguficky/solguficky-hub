using AppHost.Configuration.Models;
using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration;

/// <summary>
/// Резолвит активный профиль. Имя берётся из `--profile` (CLI) или
/// `Topology:Profile` (env `TOPOLOGY__PROFILE`), определение — из секции
/// `Topology:Profiles`. Новый профиль не требует правки кода. Публикация берёт
/// профиль из `Topology:PublishProfile`: чарт один и не зависит от того, с каким
/// профилем его собрали.
/// </summary>
internal static class ProfileResolver
{
    private const string ProfilesSection = "Topology:Profiles";
    private const string PublishProfileKey = "Topology:PublishProfile";

    // Срез запуска чарту не принадлежит: чарт с частью сервисов выглядел бы
    // полным, и выпавший сервис заметили бы только на кластере. Среда Telegram
    // тоже: чарт собирается под продакшн-среду, и флаг молча не применился бы.
    private static readonly string[] RunOnlyKeys = ["profile", "run-services", "skip-services", "telegram-environment"];

    public static ProfileConfig Resolve(IConfiguration configuration, DistributedApplicationExecutionContext executionContext) =>
        executionContext.IsPublishMode ? ResolvePublish(configuration) : Resolve(configuration);

    public static ProfileConfig Resolve(IConfiguration configuration)
    {
        var name = (configuration["profile"] ?? configuration["Topology:Profile"])
            ?.Trim()
            .ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(name))
        {
            throw new InvalidOperationException(
                "Topology profile is not set. Pass --profile <name> or set TOPOLOGY__PROFILE. " +
                $"Known profiles: {Known(configuration)}.");
        }

        var profile = Load(configuration, name);
        ApplyServiceOverrides(configuration, profile);
        return profile;
    }

    public static ProfileConfig ResolvePublish(IConfiguration configuration)
    {
        foreach (var key in RunOnlyKeys.Where(key => !string.IsNullOrWhiteSpace(configuration[key])))
        {
            throw new InvalidOperationException(
                $"--{key} does not apply to publish: the chart is built from the profile named by '{PublishProfileKey}'.");
        }

        return PublishProfile(configuration)
            ?? throw new InvalidOperationException(
                $"Publish profile is not set. Name one of the profiles in '{PublishProfileKey}'. " +
                $"Known profiles: {Known(configuration)}.");
    }

    /// <summary>
    /// Профиль, из которого собирается чарт, или <c>null</c>, если ключ не задан.
    /// Граф читает его и в локальном запуске: узел, который чарт получить не
    /// может, отвергается обычным прогоном, а не только сборкой чарта.
    /// </summary>
    public static ProfileConfig? PublishProfile(IConfiguration configuration)
    {
        var name = configuration[PublishProfileKey]?.Trim().ToLowerInvariant();
        return string.IsNullOrWhiteSpace(name) ? null : Load(configuration, name);
    }

    private static ProfileConfig Load(IConfiguration configuration, string name)
    {
        var section = configuration.GetSection($"{ProfilesSection}:{name}");
        if (!section.Exists())
        {
            throw new InvalidOperationException(
                $"Unknown topology profile '{name}': no section '{ProfilesSection}:{name}'. " +
                $"Known profiles: {Known(configuration)}.");
        }

        var profile = section.Get<ProfileConfig>() ?? new ProfileConfig();
        profile.Name = name;
        return profile;
    }

    /// <summary>
    /// Имена, которыми владеет хотя бы один профиль. Активный профиль здесь ни при
    /// чём: вопрос не «что поднимается сейчас», а «у какого узла вообще есть
    /// владелец». Срез `--run-services` на ответ не влияет — он меняет запуск, а не
    /// объявленные профили.
    /// </summary>
    public static IReadOnlySet<string> DeclaredNames(IConfiguration configuration)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var child in configuration.GetSection(ProfilesSection).GetChildren())
        {
            var profile = child.Get<ProfileConfig>();
            if (profile is null)
            {
                continue;
            }

            names.UnionWith(profile.Services);
            names.UnionWith(profile.Infrastructure);
        }

        return names;
    }

    private static void ApplyServiceOverrides(IConfiguration configuration, ProfileConfig profile)
    {
        var run = configuration["run-services"];
        if (!string.IsNullOrWhiteSpace(run))
        {
            profile.Services = [.. Split(run)];
        }

        var skip = configuration["skip-services"];
        if (!string.IsNullOrWhiteSpace(skip))
        {
            var excluded = Split(skip).ToHashSet(StringComparer.OrdinalIgnoreCase);
            profile.Services = [.. profile.Services.Where(service => !excluded.Contains(service))];
        }
    }

    private static IEnumerable<string> Split(string value) =>
        value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static string Known(IConfiguration configuration) =>
        string.Join(
            ", ",
            configuration.GetSection(ProfilesSection).GetChildren().Select(child => child.Key).Order());
}
