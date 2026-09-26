using Dapper;
using Npgsql;
using Xunit;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>
/// Общие шаги сценариев адресных фактов: люди и подписки кладутся в базу
/// напрямую, а условие дожидается опросом. Предмет таких сценариев — решение
/// «кому положено» и судьба факта, а не путь событий Identity в реплику.
/// </summary>
public static class FactFixtures
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    /// <summary>Человек в реплике Identity с этими глобальными ролями.</summary>
    public static Task<Guid> Person(IsolatedDatabase db, params string[] roles) => Person(db, blocked: false, roles);

    /// <inheritdoc cref="Person(IsolatedDatabase, string[])" />
    public static async Task<Guid> Person(IsolatedDatabase db, bool blocked, params string[] roles)
    {
        var id = Guid.CreateVersion7();
        await Execute(
            db,
            """
            INSERT INTO identity_replica (identity_id, version, global_roles, blocked, occurred_at, applied_at)
            VALUES (@Id, 1, @Roles, @Blocked, now(), now());
            """,
            new { Id = id, Roles = roles, Blocked = blocked });

        return id;
    }

    public static Task Subscribe(IsolatedDatabase db, Guid person, string meetupId) =>
        Execute(
            db,
            """
            INSERT INTO meetup_subscription (identity_id, meetup_id, subscribed_at)
            VALUES (@Person, @MeetupId, now());
            """,
            new { Person = person, MeetupId = Guid.Parse(meetupId) });

    /// <summary>
    /// Настройка категории: без <paramref name="meetupId" /> — глобальная,
    /// с ним — переопределение на одну сходку.
    /// </summary>
    public static Task Preference(IsolatedDatabase db, Guid person, string? meetupId, string category, bool enabled) =>
        Execute(
            db,
            """
            INSERT INTO notification_preference (identity_id, meetup_id, category, enabled, updated_at)
            VALUES (@Person, @MeetupId, @Category, @Enabled, now());
            """,
            new { Person = person, MeetupId = meetupId is null ? (Guid?)null : Guid.Parse(meetupId), Category = category, Enabled = enabled });

    public static async Task Execute(IsolatedDatabase db, string sql, object parameters)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        await connection.ExecuteAsync(sql, parameters);
    }

    /// <summary>Опрашивает <paramref name="probe" />, пока не выполнится <paramref name="done" />.</summary>
    public static async Task<T> Eventually<T>(Func<Task<T>> probe, Func<T, bool> done)
    {
        var deadline = DateTime.UtcNow + Patience;

        while (true)
        {
            var value = await probe();
            if (done(value))
            {
                return value;
            }

            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException($"condition not reached within {Patience}; last value: {value}");
            }

            await Task.Delay(TimeSpan.FromMilliseconds(100), TestContext.Current.CancellationToken);
        }
    }
}
