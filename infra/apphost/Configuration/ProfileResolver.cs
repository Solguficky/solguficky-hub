using AppHost.Configuration.Models;
using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration;

/// <summary>
/// Резолвит активный профиль. Имя берётся из `--profile` (CLI) или
/// `Topology:Profile` (env `TOPOLOGY__PROFILE`), определение — из секции
/// `Topology:Profiles`. Новый профиль не требует правки кода.
/// </summary>
internal static class ProfileResolver
{
    private const string ProfilesSection = "Topology:Profiles";

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

        var section = configuration.GetSection($"{ProfilesSection}:{name}");
        if (!section.Exists())
        {
            throw new InvalidOperationException(
                $"Unknown topology profile '{name}': no section '{ProfilesSection}:{name}'. " +
                $"Known profiles: {Known(configuration)}.");
        }

        var profile = section.Get<ProfileConfig>() ?? new ProfileConfig();
        profile.Name = name;

        ApplyServiceOverrides(configuration, profile);
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
