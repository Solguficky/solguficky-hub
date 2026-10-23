using Dapper;
using Npgsql;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>Строка задания начала окна так, как её видит тест.</summary>
public sealed record StepWindowTaskRow(
    Guid TaskId,
    Guid AuctionId,
    DateTime StartsAt,
    DateTime DueAt,
    string State,
    DateTime? FiredAt);

/// <summary>
/// Чтение таблицы задания начала окна мимо сервиса. Тест утверждает о строках,
/// а не о возвращённых значениях: устойчивость и единственность задания —
/// свойства схемы.
/// </summary>
public static class StepWindowProbe
{
    public static IReadOnlyList<StepWindowTaskRow> Tasks(string connectionString, Guid auctionId)
    {
        using var connection = new NpgsqlConnection(connectionString);

        return connection.Query<StepWindowTaskRow>(
            """
            SELECT task_id AS TaskId,
                   auction_id AS AuctionId,
                   starts_at AS StartsAt,
                   due_at AS DueAt,
                   state AS State,
                   fired_at AS FiredAt
            FROM step_window_task
            WHERE auction_id = @auctionId
            ORDER BY starts_at, task_id;
            """,
            new { auctionId }).ToList();
    }

    /// <summary>Несработавшие задания аукциона: по ним видно, чем кончилась отмена.</summary>
    public static int Scheduled(string connectionString, Guid auctionId) =>
        Tasks(connectionString, auctionId).Count(task => task.State == "scheduled");
}
