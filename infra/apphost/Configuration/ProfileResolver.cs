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
