using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Среда Telegram, против которой работает бот в этом запуске. Имя берётся из
/// `--telegram-environment` (CLI) или `Telegram:Environment`
/// (env `TELEGRAM__ENVIRONMENT`), по умолчанию — продакшн ([ADR-046]).
/// Среда — вторая ось рядом с профилем: профиль отвечает, каким узлом AppHost
/// владеет, среда — в какой Telegram этот узел ходит, и профиля на среду не
/// заводится. Каждая среда несёт своё имя secret parameter, поэтому прод- и
/// тест-токен живут под разными ключами user-secrets и не подменяют друг друга.
/// </summary>
internal sealed record TelegramEnvironment(string Value, string TokenParameter)
{
    private const string ConfigurationKey = "Telegram:Environment";
    private const string CommandLineKey = "telegram-environment";
    private const string DefaultName = "prod";

    private static readonly IReadOnlyDictionary<string, TelegramEnvironment> Known =
        new Dictionary<string, TelegramEnvironment>(StringComparer.Ordinal)
        {
            [DefaultName] = new(DefaultName, "telegram-bot-token"),
            ["test"] = new("test", "telegram-bot-test-token"),
        };

    public static TelegramEnvironment Resolve(IConfiguration configuration)
    {
        var name = (configuration[CommandLineKey] ?? configuration[ConfigurationKey])
            ?.Trim()
            .ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(name))
        {
            name = DefaultName;
        }

        if (!Known.TryGetValue(name, out var environment))
        {
            throw new InvalidOperationException(
                $"Unknown Telegram environment '{name}'. " +
                $"Pass --{CommandLineKey} <name> or set {ConfigurationKey}. " +
                $"Known environments: {string.Join(", ", Known.Keys.Order())}.");
        }

        return environment;
    }
}
