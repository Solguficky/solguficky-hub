using System.Security.Cryptography;
using System.Text;

namespace Notifications.Transport;

/// <summary>
/// Вызывающий процесс (ADR-056): имя узла AppHost, по которому AppHost называет
/// его токен. Вызывающий — процесс, а не человек: человек приходит в запросе
/// полем <c>identity_id</c>.
/// </summary>
public sealed record Caller(string Node)
{
    /// <summary>Бот хаба.</summary>
    public static readonly Caller TelegramBot = new("telegram-bot");

    /// <summary>
    /// Переменная, из которой AppHost отдаёт токен вызывающего: имя узла в
    /// верхнем регистре с <c>_</c> вместо <c>-</c> (integration.md, «Service authentication»).
    /// </summary>
    public string TokenVariable => $"NOTIFICATIONS_CALLER_TOKEN_{Node.ToUpperInvariant().Replace('-', '_')}";
}

/// <summary>Таблица «токен → вызывающий».</summary>
/// <remarks>
/// Хранятся не токены, а их SHA-256: сравнение идёт по дайджестам одинаковой
/// длины через <see cref="CryptographicOperations.FixedTimeEquals" />, и время
/// не зависит ни от длины присланной строки, ни от байта, на котором она
/// разошлась с настоящей. Строки перебираются все, без раннего выхода, — так же,
/// как таблица Auction и maintainer-секрет Identity.
/// </remarks>
public sealed class CallerTable
{
    private readonly IReadOnlyList<(Caller Caller, byte[] Digest)> rows;

    private CallerTable(IReadOnlyList<(Caller Caller, byte[] Digest)> rows) => this.rows = rows;

    public Caller? Identify(string token)
    {
        var presented = Digest(token);
        Caller? found = null;

        foreach (var (caller, expected) in rows)
        {
            if (CryptographicOperations.FixedTimeEquals(presented, expected))
            {
                found = caller;
            }
        }

        return found;
    }

    /// <summary>
    /// Таблица по переменной на каждого объявленного вызывающего. Сервис с
    /// неполной или неоднозначной таблицей не стартует (ADR-056): у вызывающего
    /// нет значения или оно пустое, у двух вызывающих одно значение. Причина
    /// называет переменную, но не значение: токен — секрет.
    /// </summary>
    /// <exception cref="InvalidOperationException">Таблица неполна или неоднозначна.</exception>
    public static CallerTable FromConfiguration(Func<string, string?> read, IEnumerable<Caller> declared)
    {
        // Обрезка та же, что у присланного токена в CallerGate: секрет,
        // прочитанный из файла с переводом строки, иначе не совпал бы ни с одним
        // вызовом, а значение из одних пробелов прошло бы проверку на пустоту.
        var tokens = declared
            .OrderBy(caller => caller.Node, StringComparer.Ordinal)
            .Select(caller => (Caller: caller, Token: read(caller.TokenVariable)?.Trim() ?? string.Empty))
            .ToList();

        foreach (var (caller, token) in tokens)
        {
            if (token.Length == 0)
            {
                throw new InvalidOperationException($"{caller.TokenVariable} is not set");
            }
        }

        var shared = tokens
            .GroupBy(row => row.Token, StringComparer.Ordinal)
            .FirstOrDefault(group => group.Count() > 1);

        if (shared is not null)
        {
            throw new InvalidOperationException(
                $"caller tokens are equal for {string.Join(" and ", shared.Select(row => row.Caller.Node))}");
        }

        return new CallerTable(tokens.Select(row => (row.Caller, Digest(row.Token))).ToList());
    }

    private static byte[] Digest(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));
}

/// <summary>
/// Свой токен Notifications: его несут вызовы владельцев права — Meetups и
/// Identity (ADR-056).
/// </summary>
public static class ServiceToken
{
    public const string Variable = "NOTIFICATIONS_SERVICE_TOKEN";

    /// <summary>
    /// Без своего токена сервис не стартует, как и бот: вызов владельца без него
    /// отказал бы на каждой рассылке, а health при этом был бы зелёным.
    /// </summary>
    /// <remarks>
    /// Свой токен, совпавший с токеном вызывающего, — та же неоднозначность, что
    /// два вызывающих с одним значением (ADR-056): сервис принял бы собственный
    /// токен как чужой и открыл бы его владельцу все методы того вызывающего.
    /// Причина называет вызывающего, но не значение.
    /// </remarks>
    /// <exception cref="InvalidOperationException">Значения нет, оно пустое или совпадает с токеном вызывающего.</exception>
    public static string FromConfiguration(Func<string, string?> read, CallerTable callers)
    {
        if (read(Variable)?.Trim() is not { Length: > 0 } token)
        {
            throw new InvalidOperationException($"{Variable} is not set");
        }

        if (callers.Identify(token) is { } caller)
        {
            throw new InvalidOperationException($"{Variable} equals the caller token of {caller.Node}");
        }

        return token;
    }
}
