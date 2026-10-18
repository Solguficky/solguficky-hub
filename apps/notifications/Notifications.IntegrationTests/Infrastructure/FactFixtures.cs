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
    /// Круг, наборы и права человека в реплике. Права круга и наборов заданы
    /// так, как их выводит Identity (RFC-016); выданные записями добавляет
    /// <see cref="With" />.
    /// </summary>
    public sealed record Holding(string Circle, string[] Presets, string[] Rights)
    {
        public Holding With(params string[] granted) => this with { Rights = [.. Rights, .. granted] };
    }

    /// <summary>Администратор: участник с набором admin.</summary>
    public static readonly Holding AdminHolding = new(
        "member", ["admin"], ["access_hub", "place_bids", "admit_bidders", "manage_members", "manage_meetups"]);

    /// <summary>Мейнтейнер без набора admin: назначать администраторов может, вести состав — нет.</summary>
    public static readonly Holding MaintainerHolding = new("member", ["maintainer"], ["access_hub", "place_bids", "grant_admins"]);

    public static readonly Holding MemberHolding = new("member", [], ["access_hub", "place_bids"]);

    /// <summary>Гость, допущенный к аукциону: право ставок выдано записью.</summary>
    public static readonly Holding GuestHolding = new("guest", [], ["place_bids"]);

    /// <summary>Человек в реплике Identity с этим кругом, наборами и правами.</summary>
    public static Task<Guid> Person(IsolatedDatabase db, Holding holding) => Person(db, blocked: false, holding);

    /// <summary>
    /// Заблокированный хранится так, как его пишет Identity: без круга, наборов
    /// и прав. Владение здесь — то, что у него было, и в реплику оно не попадает.
    /// </summary>
    public static async Task<Guid> Person(IsolatedDatabase db, bool blocked, Holding holding)
    {
        var id = Guid.CreateVersion7();
        await Execute(
            db,
            """
            INSERT INTO identity_replica (identity_id, version, circle, presets, rights, blocked, occurred_at, applied_at)
            VALUES (@Id, 1, @Circle, @Presets, @Rights, @Blocked, now(), now());
            """,
            new
            {
                Id = id,
                Circle = blocked ? null : holding.Circle,
                Presets = blocked ? [] : holding.Presets,
                Rights = blocked ? [] : holding.Rights,
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

    public static async Task<long> CountRows(IsolatedDatabase db, string table)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>($"SELECT count(*) FROM {table};");
    }

    public static async Task<bool> AccessRequestWasWithdrawn(IsolatedDatabase db, Guid applicant)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<bool>("""
            SELECT withdrawn_at IS NOT NULL
            FROM notification
            WHERE type = 'access_requested' AND applicant_id = @Applicant;
            """, new { Applicant = applicant });
    }

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
