using Dapper;
using Npgsql;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>Строка задания так, как её видит тест.</summary>
public sealed record ReminderTaskRow(
    Guid TaskId,
    string MeetupId,
    DateTime StartsAt,
    DateTime DueAt,
    string State,
    DateTime? FiredAt,
    Guid? SupersededBy);

/// <summary>
/// Чтение таблиц напоминания мимо сервиса. Тест утверждает о строках, а не о
/// возвращённых значениях: устойчивость задания — свойство схемы, и проверять
/// её ответом метода значит проверять не то.
/// </summary>
public static class ReminderProbe
{
    public static IReadOnlyList<ReminderTaskRow> Tasks(string connectionString, string meetupId)
    {
        using var connection = new NpgsqlConnection(connectionString);

        return connection.Query<ReminderTaskRow>(
            """
            SELECT task_id AS TaskId,
                   meetup_id AS MeetupId,
                   starts_at AS StartsAt,
                   due_at AS DueAt,
                   state AS State,
                   fired_at AS FiredAt,
                   superseded_by AS SupersededBy
            FROM reminder_task
            WHERE meetup_id = @meetupId
            ORDER BY created_at, task_id;
            """,
            new { meetupId }).ToList();
    }

    public static ReminderTaskRow? Live(string connectionString, string meetupId) =>
        Tasks(connectionString, meetupId).SingleOrDefault(task => task.State == "scheduled");

    /// <summary>
    /// Кладёт запланированное задание прямо в таблицу.
    /// </summary>
    /// <remarks>
    /// Мимо сервиса — намеренно: сценарий простоя проверяет восстановление, а
    /// не создание, и создание у него уже есть в <c>ReminderTaskTests</c>.
    /// Дочерний процесс вызвать нечем: command plane сервиса — PER-71, и до него
    /// единственный вход в задание проходит через грин внутри процесса.
    /// </remarks>
    public static Guid InsertScheduled(string connectionString, string meetupId, DateTimeOffset startsAt, DateTimeOffset dueAt)
    {
        var taskId = Guid.NewGuid();

        using var connection = new NpgsqlConnection(connectionString);

        connection.Execute(
            """
            INSERT INTO reminder_task (task_id, meetup_id, starts_at, due_at, state, created_at)
            VALUES (@taskId, @meetupId, @startsAt, @dueAt, 'scheduled', now());
            """,
            new { taskId, meetupId, startsAt = startsAt.UtcDateTime, dueAt = dueAt.UtcDateTime });

        return taskId;
    }

    /// <summary>
    /// Сдвигает момент срабатывания живого задания в прошлое.
    /// </summary>
    /// <remarks>
    /// Так тест изображает простой кластера: «время прошло, пока силоса не
    /// было». Двигаются данные, а не часы процесса — иначе сценарий нельзя было
    /// бы поставить на дочернем процессе, где подменить <c>TimeProvider</c>
    /// извне нечем.
    /// </remarks>
    public static void MoveDueToPast(string connectionString, string meetupId)
    {
        using var connection = new NpgsqlConnection(connectionString);

        var moved = connection.Execute(
            """
            UPDATE reminder_task
            SET due_at = now() - interval '1 minute'
            WHERE meetup_id = @meetupId AND state = 'scheduled';
            """,
            new { meetupId });

        if (moved != 1)
        {
            throw new InvalidOperationException(
                $"expected exactly one live task for {meetupId}, moved {moved}");
        }
    }

    public static int Occasions(string connectionString, string meetupId)
    {
        using var connection = new NpgsqlConnection(connectionString);

        return connection.ExecuteScalar<int>(
            "SELECT count(*) FROM notification_occasion WHERE meetup_id = @meetupId",
            new { meetupId });
    }

    /// <summary>
    /// Ждёт условия опросом с дедлайном.
    /// </summary>
    /// <remarks>
    /// Не <c>Task.Delay</c> на глазок: сон привязывает зелёный прогон к загрузке
    /// раннера, а норматив тестирования прямо запрещает зависеть от часов
    /// машины. Здесь часы участвуют только в дедлайне отказа — успех наступает
    /// по наблюдаемому состоянию, и на быстрой машине тест не ждёт вовсе.
    /// </remarks>
    public static async Task<T> WaitFor<T>(Func<T> probe, Func<T, bool> done, string what)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        var seen = probe();

        while (!done(seen))
        {
            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException($"{what}: not observed within 30 s, last seen {seen}");
            }

            await Task.Delay(50);
            seen = probe();
        }

        return seen;
    }
}
