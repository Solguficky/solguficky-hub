using Dapper;
using Microsoft.Extensions.Options;
using Notifications.Facts;
using Npgsql;
using Notifications.Replica;

namespace Notifications.Infrastructure;

/// <summary>
/// Запись реплики чужих фактов и её ключей дедупликации. Dapper поверх Npgsql —
/// набор <c>docs/standards/data/postgresql.md</c>.
/// </summary>
/// <remarks>
/// Обе защиты — от повтора и от переупорядочивания — стоят в SQL, а не в коде
/// рядом с ним: <c>ON CONFLICT DO NOTHING</c> по ключу и <c>WHERE version &lt;
/// EXCLUDED.version</c> на строке. Поэтому два экземпляра сервиса на одном
/// durable безопасны без грина и без блокировок в памяти: гонку разводит
/// блокировка строки PostgreSQL.
/// </remarks>
public sealed class ReplicaStore(NpgsqlDataSource source, IOptions<FactOptions> factOptions)
{
    static ReplicaStore()
    {
        // Dapper 2.1 не знает DateOnly и TimeOnly как параметры, а Npgsql
        // пишет их в date и time сам. Обработчик только пропускает значение
        // до драйвера; регистрация глобальна, поэтому идёт один раз.
        SqlMapper.AddTypeHandler(new PassThrough<DateOnly>(System.Data.DbType.Date));
        SqlMapper.AddTypeHandler(new PassThrough<TimeOnly>(System.Data.DbType.Time));
    }

    private const string ConsumeSql = """
        INSERT INTO consumed_event (source, event_id, consumed_at)
        VALUES (@Source, @EventId, @Now)
        ON CONFLICT (source, event_id) DO NOTHING;
        """;

    // Прежний снимок для разницы с событием. FOR UPDATE держит строку до конца
    // транзакции: конкурент на том же durable ждёт, и снимок, с которым
    // сравнивали, остаётся тем, что upsert ниже заменит. Решение о порядке
    // принимает не это чтение, а WHERE версии в upsert.
    private const string MeetupBeforeSql = """
        SELECT title AS Title, description AS Description, venue AS Venue, kind AS Kind,
               calendar_link AS CalendarLink, lifecycle AS Lifecycle, visibility AS Visibility,
               schedule_form AS ScheduleForm, schedule_precision AS SchedulePrecision,
               schedule_start_date AS ScheduleStartDate, schedule_start_time AS ScheduleStartTime,
               schedule_end_date AS ScheduleEndDate, schedule_end_time AS ScheduleEndTime
        FROM meetup_replica
        WHERE meetup_id = @MeetupId
        FOR UPDATE;
        """;

    // Последнее слово реплики о сходке, без блокировки: его читают грин
    // напоминания и срабатывание, а решение о порядке уже принял upsert.
    private const string MeetupLatestSql = """
        SELECT title AS Title, description AS Description, venue AS Venue, kind AS Kind,
               calendar_link AS CalendarLink, lifecycle AS Lifecycle, visibility AS Visibility,
               schedule_form AS ScheduleForm, schedule_precision AS SchedulePrecision,
               schedule_start_date AS ScheduleStartDate, schedule_start_time AS ScheduleStartTime,
               schedule_end_date AS ScheduleEndDate, schedule_end_time AS ScheduleEndTime
        FROM meetup_replica
        WHERE meetup_id = @MeetupId;
        """;

    private const string MeetupSql = """
        INSERT INTO meetup_replica (
            meetup_id, version, author,
            title, description, venue, kind, calendar_link,
            lifecycle, visibility, first_published_at,
            schedule_form, schedule_precision,
            schedule_start_date, schedule_start_time, schedule_end_date, schedule_end_time,
            occurred_at, applied_at)
        VALUES (
            @MeetupId, @Version, @Author,
            @Title, @Description, @Venue, @Kind, @CalendarLink,
            @Lifecycle, @Visibility, @FirstPublishedAt,
            @ScheduleForm, @SchedulePrecision,
            @ScheduleStartDate, @ScheduleStartTime, @ScheduleEndDate, @ScheduleEndTime,
            @OccurredAt, @Now)
        ON CONFLICT (meetup_id) DO UPDATE SET
            version = EXCLUDED.version,
            author = EXCLUDED.author,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            venue = EXCLUDED.venue,
            kind = EXCLUDED.kind,
            calendar_link = EXCLUDED.calendar_link,
            lifecycle = EXCLUDED.lifecycle,
            visibility = EXCLUDED.visibility,
            first_published_at = EXCLUDED.first_published_at,
            schedule_form = EXCLUDED.schedule_form,
            schedule_precision = EXCLUDED.schedule_precision,
            schedule_start_date = EXCLUDED.schedule_start_date,
            schedule_start_time = EXCLUDED.schedule_start_time,
            schedule_end_date = EXCLUDED.schedule_end_date,
            schedule_end_time = EXCLUDED.schedule_end_time,
            occurred_at = EXCLUDED.occurred_at,
            applied_at = EXCLUDED.applied_at
        WHERE meetup_replica.version < EXCLUDED.version;
        """;

    private const string IdentitySql = """
        INSERT INTO identity_replica (identity_id, version, global_roles, blocked, occurred_at, applied_at)
        VALUES (@IdentityId, @Version, @GlobalRoles, @Blocked, @OccurredAt, @Now)
        ON CONFLICT (identity_id) DO UPDATE SET
            version = EXCLUDED.version,
            global_roles = EXCLUDED.global_roles,
            blocked = EXCLUDED.blocked,
            occurred_at = EXCLUDED.occurred_at,
            applied_at = EXCLUDED.applied_at
        WHERE identity_replica.version < EXCLUDED.version;
        """;

    private const string LastMeetupSql = "SELECT MAX(occurred_at) FROM meetup_replica;";

    private const string LastIdentitySql = "SELECT MAX(occurred_at) FROM identity_replica;";

    private const string PruneSql = "DELETE FROM consumed_event WHERE consumed_at < @Threshold;";

    /// <summary>
    /// Применяет факт: записывает ключ, снимок, если версия новее, и адресные
    /// факты, если событие — повод. Всё в одной транзакции: ключ без эффекта
    /// или эффект без ключа означали бы потерянное или дважды применённое
    /// событие, а повод без ключа — второй разворот на повторе.
    /// </summary>
    public async Task<ReplicaApplication> Apply(ReplicaEvent fact, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var consumed = await work.Execute(
            ConsumeSql,
            new { fact.Source, fact.EventId, Now = now.UtcDateTime },
            cancellationToken);

        if (consumed == 0)
        {
            // Ничего не записано, фиксировать нечего: откат при разборе.
            return ReplicaApplication.Duplicate;
        }

        ProducedFacts? facts = null;
        int written;

        if (fact is MeetupFact meetup)
        {
            var before = await work.Query<MeetupBeforeRow>(MeetupBeforeSql, new { meetup.MeetupId }, cancellationToken);
            written = await work.Execute(MeetupSql, MeetupRow(meetup, now), cancellationToken);

            // Разница считается, только если реплика сдвинулась: сравнивать
            // запоздавший снимок с более поздним значило бы объявить откат,
            // которого не было. Строки до события нет — сравнивать не с чем,
            // и это верно: черновик никому не виден. Цена: два первых события
            // сходки, применённые одновременно двумя экземплярами, оба видят
            // пустое «до» — FOR UPDATE по отсутствующей строке ничего не
            // держит, — и разница второго теряется. Первое событие сходки —
            // создание черновика, так что потеряться может только правка
            // черновика, который никому не виден.
            var changed = written > 0 && before.Count == 1
                ? MeetupDiff.Between(before[0].State(), meetup.State)
                : [];

            // Повод со своим типом не зависит от того, тронул ли снимок
            // реплику: запоздавшее событие версию не двигает, но первая
            // публикация, снятие и материал от этого не перестают быть
            // случившимися (007_fact_replica, комментарий к consumed_event).
            // Кому их объявлять, решает уже обновлённая реплика.
            facts = await NotificationStore.AddForMeetupEvent(
                work,
                meetup,
                changed,
                now,
                factOptions.Value.StaleAfter,
                cancellationToken);
        }
        else if (fact is IdentityFact identity)
        {
            written = await work.Execute(IdentitySql, IdentityRow(identity, now), cancellationToken);
        }
        else
        {
            throw new ArgumentOutOfRangeException(nameof(fact), fact.GetType().Name, "unknown replica fact");
        }

        // Устаревшее событие фиксируется вместе с ключом, хотя реплику не
        // трогает: без ключа его нечем подтвердить, и оно вернулось бы снова.
        await work.Commit(cancellationToken);

        return new ReplicaApplication(written == 0 ? ReplicaOutcome.Stale : ReplicaOutcome.Applied, facts);
    }

    /// <summary>
    /// Снимок сходки в реплике; <c>null</c>, если реплика о ней не знает. Автор
    /// и отметка первой публикации в снимке пусты: ни напоминанию, ни карточке
    /// они не нужны.
    /// </summary>
    public async Task<MeetupReplicaState?> Meetup(Guid meetupId, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var row = await connection.QuerySingleOrDefaultAsync<MeetupBeforeRow>(
            new CommandDefinition(MeetupLatestSql, new { MeetupId = meetupId }, cancellationToken: cancellationToken));

        return row?.State();
    }

    /// <inheritdoc cref="Meetup(Guid, CancellationToken)" />
    /// <remarks>То же чтение внутри чужой транзакции.</remarks>
    internal static async Task<MeetupReplicaState?> Meetup(UnitOfWork work, Guid meetupId, CancellationToken cancellationToken)
    {
        var rows = await work.Query<MeetupBeforeRow>(MeetupLatestSql, new { MeetupId = meetupId }, cancellationToken);

        return rows.Count == 1 ? rows[0].State() : null;
    }

    /// <summary>
    /// Момент коммита самого позднего применённого события источника. Нужен
    /// телеметрии после рестарта: без него возраст реплики до первого события
    /// был бы неизвестен.
    /// </summary>
    public async Task<DateTimeOffset?> LastOccurredAt(string replicaSource, CancellationToken cancellationToken)
    {
        var sql = replicaSource switch
        {
            ReplicaFeeds.MeetupsSource => LastMeetupSql,
            ReplicaFeeds.IdentitySource => LastIdentitySql,
            _ => throw new ArgumentOutOfRangeException(nameof(replicaSource), replicaSource, "unknown replica source"),
        };

        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var last = await connection.ExecuteScalarAsync<DateTime?>(
            new CommandDefinition(sql, cancellationToken: cancellationToken));

        return last is { } moment ? new DateTimeOffset(DateTime.SpecifyKind(moment, DateTimeKind.Utc)) : null;
    }

    /// <summary>Снимает ключи, записанные раньше порога. Возвращает их число.</summary>
    public async Task<int> Prune(DateTimeOffset threshold, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        return await connection.ExecuteAsync(
            new CommandDefinition(PruneSql, new { Threshold = threshold.UtcDateTime }, cancellationToken: cancellationToken));
    }

    private static object MeetupRow(MeetupFact fact, DateTimeOffset now)
    {
        var state = fact.State;
        var schedule = state.Schedule;

        return new
        {
            fact.MeetupId,
            fact.Version,
            state.Author,
            state.Title,
            state.Description,
            state.Venue,
            state.Kind,
            state.CalendarLink,
            state.Lifecycle,
            state.Visibility,
            FirstPublishedAt = state.FirstPublishedAt?.UtcDateTime,
            ScheduleForm = schedule.Form,
            SchedulePrecision = schedule.Precision,
            ScheduleStartDate = schedule.StartDate,
            ScheduleStartTime = schedule.StartTime,
            ScheduleEndDate = schedule.EndDate,
            ScheduleEndTime = schedule.EndTime,
            OccurredAt = fact.OccurredAt.UtcDateTime,
            Now = now.UtcDateTime,
        };
    }

    // Класс, а не позиционная запись: Dapper сопоставляет колонки со
    // свойствами по имени. date и time Npgsql отдаёт как DateOnly и TimeOnly,
    // и обработчик PassThrough пропускает их без перевода.
    private sealed class MeetupBeforeRow
    {
        public string Title { get; init; } = string.Empty;

        public string Description { get; init; } = string.Empty;

        public string Venue { get; init; } = string.Empty;

        public string Kind { get; init; } = string.Empty;

        public string CalendarLink { get; init; } = string.Empty;

        public string Lifecycle { get; init; } = string.Empty;

        public string Visibility { get; init; } = string.Empty;

        public string ScheduleForm { get; init; } = string.Empty;

        public string? SchedulePrecision { get; init; }

        public DateOnly? ScheduleStartDate { get; init; }

        public TimeOnly? ScheduleStartTime { get; init; }

        public DateOnly? ScheduleEndDate { get; init; }

        public TimeOnly? ScheduleEndTime { get; init; }

        // Автор и отметка первой публикации аспектами разницы не являются,
        // поэтому не читаются: в сравнении они подставлены пустыми значениями
        // и MeetupDiff их не смотрит.
        public MeetupReplicaState State() =>
            new(
                Guid.Empty,
                Title,
                Description,
                Venue,
                Kind,
                CalendarLink,
                Lifecycle,
                Visibility,
                null,
                new ScheduleColumns(
                    ScheduleForm,
                    SchedulePrecision,
                    ScheduleStartDate,
                    ScheduleStartTime,
                    ScheduleEndDate,
                    ScheduleEndTime));
    }

    private sealed class PassThrough<T>(System.Data.DbType type) : SqlMapper.TypeHandler<T>
    {
        public override void SetValue(System.Data.IDbDataParameter parameter, T? value)
        {
            parameter.DbType = type;
            parameter.Value = value;
        }

        public override T Parse(object value) => (T)value;
    }

    private static object IdentityRow(IdentityFact fact, DateTimeOffset now) =>
        new
        {
            fact.IdentityId,
            fact.Version,
            GlobalRoles = fact.GlobalRoles.ToArray(),
            fact.Blocked,
            OccurredAt = fact.OccurredAt.UtcDateTime,
            Now = now.UtcDateTime,
        };
}
