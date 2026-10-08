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

    /// <summary>
    /// Роль-круг и права человека в реплике. Права круга заданы так, как их
    /// выводит Identity (ADR-064, пункт 7); выданные отдельно добавляет
    /// <see cref="With" />.
    /// </summary>
    public sealed record Circle(string Role, string[] Rights)
    {
        public Circle With(params string[] granted) => this with { Rights = [.. Rights, .. granted] };
    }

    public static readonly Circle AdminCircle = new("admin", ["hub", "auction", "manage_membership", "moderate_auction"]);

    public static readonly Circle MaintainerCircle = new("maintainer", ["hub", "auction"]);

    public static readonly Circle MemberCircle = new("member", ["hub", "auction"]);

    /// <summary>Гость, допущенный к аукциону: право аукциона выдано записью.</summary>
    public static readonly Circle GuestCircle = new("guest", ["auction"]);

    /// <summary>Человек в реплике Identity с этой ролью и правами.</summary>
    public static Task<Guid> Person(IsolatedDatabase db, Circle circle) => Person(db, blocked: false, circle);

    /// <summary>
    /// Заблокированный хранится так, как его пишет Identity: без роли и прав.
    /// Круг здесь — тот, что у него был, и в реплику он не попадает.
    /// </summary>
    public static async Task<Guid> Person(IsolatedDatabase db, bool blocked, Circle circle)
    {
        var id = Guid.CreateVersion7();
        await Execute(
            db,
            """
            INSERT INTO identity_replica (identity_id, version, role, rights, blocked, occurred_at, applied_at)
            VALUES (@Id, 1, @Role, @Rights, @Blocked, now(), now());
            """,
            new
            {
                Id = id,
                Role = blocked ? null : circle.Role,
                Rights = blocked ? [] : circle.Rights,
                Blocked = blocked,
            });

        return id;
    }

    /// <summary>
    /// Сходка в реплике Meetups: опубликованная, без даты. Карточке рассылки
    /// большего не нужно, а путь события в реплику — предмет других сценариев.
    /// </summary>
    /// <param name="meetupId">Идентификатор, который тест уже использовал; иначе новый.</param>
    public static async Task<string> Meetup(IsolatedDatabase db, string title = "Сходка", string? meetupId = null)
    {
        var id = meetupId is null ? Guid.CreateVersion7() : Guid.Parse(meetupId);
        await Execute(
            db,
            """
            INSERT INTO meetup_replica (
                meetup_id, version, author, title, description, venue, kind, calendar_link,
                lifecycle, visibility, schedule_form, occurred_at, applied_at)
            VALUES (@Id, 1, @Id, @Title, 'Описание', 'Бар', 'встреча', '', 'planned', 'visible', 'no_date', now(), now());
            """,
            new { Id = id, Title = title });

        return id.ToString();
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
