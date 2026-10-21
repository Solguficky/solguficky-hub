using Dapper;
using Npgsql;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>Строка задания напоминания о счёте так, как её видит тест.</summary>
public sealed record InvoiceReminderTaskRow(
    Guid TaskId,
    Guid InvoiceId,
    string Kind,
    DateTime DueAt,
    string State,
    DateTime? FiredAt,
    string? Reason);

/// <summary>Строка адресного факта напоминания о счёте так, как её видит тест.</summary>
public sealed class InvoiceReminderFactRow
{
    public string Type { get; init; } = "";

    public DateTime? DispatchedAt { get; init; }

    public DateTime? WithdrawnAt { get; init; }

    public string? WithdrawalReason { get; init; }
}

/// <summary>
/// Чтение таблицы напоминания о счёте мимо сервиса. Тест утверждает о строках,
/// а не о возвращённых значениях: устойчивость задания — свойство схемы.
/// </summary>
public static class InvoiceReminderProbe
{
    /// <summary>Вид задания после победы: примерно через 12 часов.</summary>
    public const string AfterWin = "after_win";

    /// <summary>Вид задания перед сроком оплаты: за сутки.</summary>
    public const string BeforeDue = "before_due";

    public static IReadOnlyList<InvoiceReminderTaskRow> Tasks(string connectionString, Guid invoiceId)
    {
        using var connection = new NpgsqlConnection(connectionString);

        return connection.Query<InvoiceReminderTaskRow>(
            """
            SELECT task_id AS TaskId,
                   invoice_id AS InvoiceId,
                   kind AS Kind,
                   due_at AS DueAt,
                   state AS State,
                   fired_at AS FiredAt,
                   reason AS Reason
            FROM invoice_reminder_task
            WHERE invoice_id = @invoiceId
            ORDER BY created_at, task_id;
            """,
            new { invoiceId }).ToList();
    }

    public static InvoiceReminderTaskRow? Live(string connectionString, Guid invoiceId, string kind) =>
        Tasks(connectionString, invoiceId)
            .SingleOrDefault(task => task.State == "scheduled" && task.Kind == kind);

    /// <summary>Сколько адресных фактов напоминания о счёте записано.</summary>
    public static long Facts(string connectionString, string type)
    {
        using var connection = new NpgsqlConnection(connectionString);

        return connection.ExecuteScalar<long>(
            "SELECT count(*) FROM notification WHERE type = @Type;",
            new { Type = type });
    }

    /// <summary>Строки адресных фактов: их срок и снятие видно глазами.</summary>
    public static IReadOnlyList<InvoiceReminderFactRow> Rows(string connectionString)
    {
        using var connection = new NpgsqlConnection(connectionString);

        return connection.Query<InvoiceReminderFactRow>(
            """
            SELECT type AS Type, dispatched_at AS DispatchedAt, withdrawn_at AS WithdrawnAt,
                   withdrawal_reason AS WithdrawalReason
            FROM notification
            ORDER BY created_at, type;
            """).ToList();
    }

    /// <summary>
    /// Сдвигает момент срабатывания живого задания в прошлое. Так тест изображает
    /// простой кластера: «время прошло, пока силоса не было». Двигаются данные,
    /// а не часы процесса.
    /// </summary>
    public static void MoveDueToPast(string connectionString, Guid invoiceId, string kind)
    {
        using var connection = new NpgsqlConnection(connectionString);

        var moved = connection.Execute(
            """
            UPDATE invoice_reminder_task
            SET due_at = now() - interval '1 minute'
            WHERE invoice_id = @invoiceId AND kind = @kind AND state = 'scheduled';
            """,
            new { invoiceId, kind });

        if (moved != 1)
        {
            throw new InvalidOperationException(
                $"expected exactly one live invoice reminder task of kind {kind} for {invoiceId}, moved {moved}");
        }
    }
}
