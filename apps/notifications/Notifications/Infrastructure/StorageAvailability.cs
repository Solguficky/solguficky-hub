using System.Data.Common;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>
/// Недоступность собственной базы: предел, за который она распознаётся, и
/// признак, по которому отказ относится к ней, а не к запросу.
/// </summary>
/// <remarks>
/// Правило общее для трёх сервисов и записано в ADR-054:
/// недоступная база отвечает клиенту <c>UNAVAILABLE</c> раньше его дедлайна, а
/// дефект SQL на живом соединении этим кодом не отвечает.
/// </remarks>
public static class StorageAvailability
{
    /// <summary>
    /// Предел установления соединения, если строка подключения не задала свой
    /// <c>Timeout</c>. Умолчание Npgsql — 15 секунд, дольше трёх секунд
    /// дедлайна бота; Npgsql принимает только целые секунды.
    /// </summary>
    public const int ConnectTimeoutSeconds = 2;

    /// <summary>
    /// Ставит предел подключения, если строка его не задала. Явный <c>Timeout</c>
    /// выигрывает: развёртывание вправе задать свой.
    /// </summary>
    /// <remarks>
    /// Проверка по исходной строке, а не по построителю Npgsql: тот всегда
    /// отвечает значением, умолчание оно или явное.
    /// </remarks>
    public static string WithConnectTimeout(string connectionString)
    {
        var explicitKeys = new DbConnectionStringBuilder { ConnectionString = connectionString };

        if (explicitKeys.ContainsKey("Timeout"))
        {
            return connectionString;
        }

        return new NpgsqlConnectionStringBuilder(connectionString) { Timeout = ConnectTimeoutSeconds }.ConnectionString;
    }

    /// <summary>
    /// Отказала ли база на уровне соединения, а не запроса.
    /// </summary>
    /// <remarks>
    /// <c>PostgresException</c> — ответ живого сервера, и недоступностью он
    /// считается только с SQLSTATE класса 08 или 57P01–57P03; последний
    /// PostgreSQL отдаёт первые секунды после старта. Прочий
    /// <c>NpgsqlException</c> рождается на стороне клиента: отказ подключения,
    /// обрыв потока, исчерпание пула. <c>IsTransient</c> не годится — он
    /// причисляет к временным и конфликт сериализации.
    /// </remarks>
    public static bool IsUnavailable(Exception error) =>
        error switch
        {
            PostgresException refused =>
                refused.SqlState.StartsWith("08", StringComparison.Ordinal)
                || refused.SqlState is "57P01" or "57P02" or "57P03",
            NpgsqlException => true,
            _ => false,
        };
}
