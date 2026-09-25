using Dapper;
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
public sealed class ReplicaStore(NpgsqlDataSource source)
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
    /// Применяет факт: записывает ключ и, если версия новее, снимок. Обе записи
    /// в одной транзакции — ключ без эффекта или эффект без ключа означали бы
    /// потерянное или дважды применённое событие.
    /// </summary>
    public async Task<ReplicaOutcome> Apply(ReplicaEvent fact, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var consumed = await work.Execute(
            ConsumeSql,
            new { fact.Source, fact.EventId, Now = now.UtcDateTime },
            cancellationToken);

        if (consumed == 0)
        {
            // Ничего не записано, фиксировать нечего: откат при разборе.
            return ReplicaOutcome.Duplicate;
        }

        var written = fact switch
        {
            MeetupFact meetup => await work.Execute(MeetupSql, MeetupRow(meetup, now), cancellationToken),
            IdentityFact identity => await work.Execute(IdentitySql, IdentityRow(identity, now), cancellationToken),
            _ => throw new ArgumentOutOfRangeException(nameof(fact), fact.GetType().Name, "unknown replica fact"),
        };

        // Устаревшее событие фиксируется вместе с ключом, хотя реплику не
        // трогает: без ключа его нечем подтвердить, и оно вернулось бы снова.
        await work.Commit(cancellationToken);

        return written == 0 ? ReplicaOutcome.Stale : ReplicaOutcome.Applied;
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
