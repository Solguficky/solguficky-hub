using Dapper;
using Npgsql;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>Строка задания напоминания о лоте так, как её видит тест.</summary>
public sealed record LotReminderTaskRow(
    Guid TaskId,
    Guid LotId,
    string Kind,
    DateTime Deadline,
    DateTime DueAt,
    string State,
    DateTime? FiredAt,
    Guid? SupersededBy);

/// <summary>
/// Чтение таблицы напоминания о лоте мимо сервиса. Тест утверждает о строках, а
/// не о возвращённых значениях: устойчивость задания — свойство схемы.
/// </summary>
public static class LotReminderProbe
{
    /// <summary>Вид задания часом: за час до дедлайна.</summary>
    public const string Hour = "hour";

    /// <summary>Вид задания ближнего момента: за 15 минут до дедлайна.</summary>
    public const string Close = "close";

    public static IReadOnlyList<LotReminderTaskRow> Tasks(string connectionString, Guid lotId)
    {
        using var connection = new NpgsqlConnection(connectionString);

        return connection.Query<LotReminderTaskRow>(
            """
            SELECT task_id AS TaskId,
                   lot_id AS LotId,
                   kind AS Kind,
                   deadline AS Deadline,
                   due_at AS DueAt,
                   state AS State,
                   fired_at AS FiredAt,
                   superseded_by AS SupersededBy
            FROM lot_reminder_task
            WHERE lot_id = @lotId
            ORDER BY created_at, task_id;
            """,
            new { lotId }).ToList();
    }

    public static LotReminderTaskRow? Live(string connectionString, Guid lotId, string kind) =>
        Tasks(connectionString, lotId)
            .SingleOrDefault(task => task.State == "scheduled" && task.Kind == kind);

    /// <summary>
    /// Сдвигает момент срабатывания живого задания в прошлое. Так тест изображает
    /// простой кластера: «время прошло, пока силоса не было». Двигаются данные,
    /// а не часы процесса.
    /// </summary>
    public static void MoveDueToPast(string connectionString, Guid lotId, string kind)
    {
        using var connection = new NpgsqlConnection(connectionString);

        var moved = connection.Execute(
            """
            UPDATE lot_reminder_task
            SET due_at = now() - interval '1 minute'
            WHERE lot_id = @lotId AND kind = @kind AND state = 'scheduled';
            """,
            new { lotId, kind });

        if (moved != 1)
        {
            throw new InvalidOperationException(
                $"expected exactly one live lot reminder task of kind {kind} for {lotId}, moved {moved}");
        }
    }
}
