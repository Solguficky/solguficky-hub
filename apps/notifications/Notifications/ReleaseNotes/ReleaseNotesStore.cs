using Microsoft.Extensions.Options;
using Notifications.Domain;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Reminders;
using Npgsql;

namespace Notifications.ReleaseNotes;

/// <summary>
/// Память выпуска (ADR-069, п. 2–4): записи, впервые увиденные средой, последний
/// набор поверхности и её суточные сводки.
/// </summary>
/// <remarks>
/// Приём и закрытие сводки берут одну блокировку — строку поверхности, —
/// поэтому набор, пришедший посреди закрытия, ждёт его коммита и в уже
/// собранную сводку не попадает. Единственность сводки за час держит та же
/// строка: закрытие переносит её момент на завтра в своей транзакции, и второй
/// проход, дошедший до неё, видит час ненаступившим.
/// </remarks>
public sealed class ReleaseNotesStore(
    NpgsqlDataSource source,
    CommunityTime community,
    CategoryDefaults defaults,
    IOptions<ReleaseNotesOptions> options,
    IOptions<FactOptions> facts)
{
    // Первый приём: строки поверхности ещё нет. ON CONFLICT ждёт коммита
    // параллельного первого приёма и возвращает ноль строк — тогда этот приём
    // уже не первый и идёт обычным путём.
    private const string FirstReportSql = """
        INSERT INTO release_surface (surface, first_reported_at, reported_at, record_ids, next_summary_at)
        VALUES (@Surface, @Now, @Now, @RecordIds, @NextSummaryAt)
        ON CONFLICT (surface) DO NOTHING
        RETURNING surface;
        """;

    private const string LockSurfaceSql = """
        SELECT surface FROM release_surface WHERE surface = @Surface FOR UPDATE;
        """;

    private const string ReplaceSetSql = """
        UPDATE release_surface SET record_ids = @RecordIds, reported_at = @Now WHERE surface = @Surface;
        """;

    // Запись, которую среда уже видела, не трогается: ни момент, ни
    // объявленность. Поэтому повтор набора ничего не меняет, а запись,
    // вернувшаяся после отката, ждёт сводки с прежним моментом.
    private const string RememberSql = """
        INSERT INTO release_record (surface, record_id, first_seen_at, seen_position, announced_at)
        SELECT @Surface, record_id, @Now, position, @AnnouncedAt
        FROM unnest(@RecordIds) WITH ORDINALITY AS reported (record_id, position)
        ON CONFLICT (surface, record_id) DO NOTHING;
        """;

    private const string DueSql = """
        SELECT surface FROM release_surface WHERE next_summary_at <= @Now ORDER BY surface;
        """;

    // SKIP LOCKED: поверхность, которую держит приём или второй экземпляр,
    // достанется следующему проходу, а не задержит этот.
    private const string TakeDueSql = """
        SELECT record_ids AS RecordIds FROM release_surface
        WHERE surface = @Surface AND next_summary_at <= @Now
        FOR UPDATE SKIP LOCKED;
        """;

    // Только записи последнего набора: запись, которую откат образа убрал,
    // ждёт набора, где она снова есть (ADR-069, п. 4).
    private const string PendingSql = """
        SELECT record_id FROM release_record
        WHERE surface = @Surface AND announced_at IS NULL AND record_id = ANY(@RecordIds)
        ORDER BY first_seen_at, seen_position, record_id;
        """;

    private const string InsertSummarySql = """
        INSERT INTO release_summary (summary_id, surface, summarized_at, record_ids)
        VALUES (@SummaryId, @Surface, @Now, @RecordIds);
        """;

    private const string AnnounceSql = """
        UPDATE release_record SET announced_at = @Now, summary_id = @SummaryId
        WHERE surface = @Surface AND record_id = ANY(@RecordIds);
        """;

    private const string RescheduleSql = """
        UPDATE release_surface SET next_summary_at = @NextSummaryAt WHERE surface = @Surface;
        """;

    private const string NewestSql = """
        SELECT summary_id AS SummaryId, summarized_at AS SummarizedAt, record_ids AS RecordIds
        FROM release_summary
        WHERE surface = @Surface
        ORDER BY summary_id DESC
        LIMIT @Limit;
        """;

    private const string OlderSql = """
        SELECT summary_id AS SummaryId, summarized_at AS SummarizedAt, record_ids AS RecordIds
        FROM release_summary
        WHERE surface = @Surface AND summary_id < @Before
        ORDER BY summary_id DESC
        LIMIT @Limit;
        """;

    private const string OneSql = """
        SELECT summary_id AS SummaryId, summarized_at AS SummarizedAt, record_ids AS RecordIds
        FROM release_summary
        WHERE surface = @Surface AND summary_id = @SummaryId;
        """;

    private const string NeighboursSql = """
        SELECT
            (SELECT summary_id FROM release_summary WHERE surface = @Surface AND summary_id < @SummaryId
                ORDER BY summary_id DESC LIMIT 1) AS Older,
            (SELECT summary_id FROM release_summary WHERE surface = @Surface AND summary_id > @SummaryId
                ORDER BY summary_id LIMIT 1) AS Newer;
        """;

    /// <summary>
    /// Принимает полный набор поверхности. Первый приём помечает весь набор
    /// объявленным без сводки (ADR-069, п. 3); следующий дописывает только
    /// записи, которых среда ещё не видела, и заменяет последний набор.
    /// </summary>
    /// <returns><c>true</c> — это был первый приём поверхности.</returns>
    public async Task<bool> Report(ReleaseSurface surface, IReadOnlyList<string> recordIds, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var set = recordIds.ToArray();
        var first = (await work.Query<string>(FirstReportSql, new
        {
            Surface = surface.Name,
            Now = now.UtcDateTime,
            RecordIds = set,
            NextSummaryAt = ReleaseSchedule.Next(community, options.Value.SummaryTime, now).UtcDateTime,
        }, cancellationToken)).Count == 1;

        if (!first)
        {
            await work.Query<string>(LockSurfaceSql, new { Surface = surface.Name }, cancellationToken);
            await work.Execute(ReplaceSetSql, new { Surface = surface.Name, Now = now.UtcDateTime, RecordIds = set },
                cancellationToken);
        }

        await work.Execute(RememberSql, new
        {
            Surface = surface.Name,
            Now = now.UtcDateTime,
            RecordIds = set,
            AnnouncedAt = first ? now.UtcDateTime : (DateTime?)null,
        }, cancellationToken);

        await work.Commit(cancellationToken);
        return first;
    }

    /// <summary>Поверхности, у которых наступил час сводки.</summary>
    public async Task<IReadOnlyList<ReleaseSurface>> Due(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var due = await work.Query<string>(DueSql, new { Now = now.UtcDateTime }, cancellationToken);
        await work.Commit(cancellationToken);
        return due.Select(ReleaseSurface.FromStorage).ToArray();
    }

    /// <summary>
    /// Закрывает наступивший час поверхности своей транзакцией: сводка из
    /// необъявленных записей последнего набора и факт на каждого адресата, затем
    /// момент следующей сводки. Новых записей нет — сводки нет, а час всё равно
    /// переносится.
    /// </summary>
    /// <returns>Сводка и число фактов; <c>null</c> — сводки нет или час уже закрыл другой проход.</returns>
    public async Task<ClosedSummary?> Close(ReleaseSurface surface, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var key = new { Surface = surface.Name, Now = now.UtcDateTime };
        var taken = await work.Query<SetRow>(TakeDueSql, key, cancellationToken);
        if (taken.Count == 0)
        {
            return null;
        }

        var pending = await work.Query<string>(PendingSql, new { Surface = surface.Name, taken[0].RecordIds },
            cancellationToken);
        ClosedSummary? closed = null;
        if (pending.Count > 0)
        {
            var summary = new StoredSummary(Guid.CreateVersion7(now), now, pending);
            var parameters = new
            {
                summary.SummaryId,
                Surface = surface.Name,
                Now = now.UtcDateTime,
                RecordIds = pending.ToArray(),
            };
            await work.Execute(InsertSummarySql, parameters, cancellationToken);
            await work.Execute(AnnounceSql, parameters, cancellationToken);
            var count = await NotificationStore.AddReleaseSummary(work, surface, summary,
                defaults.Of(ReleaseFacts.Category), now, now + facts.Value.StaleAfter, cancellationToken);
            closed = new ClosedSummary(summary, count);
        }

        await work.Execute(RescheduleSql, new
        {
            Surface = surface.Name,
            NextSummaryAt = ReleaseSchedule.Next(community, options.Value.SummaryTime, now).UtcDateTime,
        }, cancellationToken);
        await work.Commit(cancellationToken);
        return closed;
    }

    /// <summary>Страница сводок поверхности, новые первыми, строго старше <paramref name="before" />.</summary>
    /// <returns>Не больше <paramref name="limit" /> сводок и признак, что есть ещё.</returns>
    public async Task<(IReadOnlyList<StoredSummary> Summaries, bool More)> Page(ReleaseSurface surface, Guid? before,
        int limit, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        // Одна лишняя строка отвечает, есть ли продолжение, без второго запроса.
        var rows = before is { } anchor
            ? await work.Query<SummaryRow>(OlderSql,
                new { Surface = surface.Name, Before = anchor, Limit = limit + 1 }, cancellationToken)
            : await work.Query<SummaryRow>(NewestSql, new { Surface = surface.Name, Limit = limit + 1 },
                cancellationToken);
        await work.Commit(cancellationToken);
        return (rows.Take(limit).Select(row => row.Stored()).ToArray(), rows.Count > limit);
    }

    /// <summary>Сводка поверхности с соседями; <c>null</c> — у поверхности такой сводки нет.</summary>
    public async Task<SummaryWithNeighbours?> One(ReleaseSurface surface, Guid summaryId,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var key = new { Surface = surface.Name, SummaryId = summaryId };
        var found = await work.Query<SummaryRow>(OneSql, key, cancellationToken);
        if (found.Count == 0)
        {
            return null;
        }

        var neighbours = (await work.Query<NeighbourRow>(NeighboursSql, key, cancellationToken)).Single();
        await work.Commit(cancellationToken);
        return new SummaryWithNeighbours(found[0].Stored(), neighbours.Older, neighbours.Newer);
    }

    // Классы, а не позиционные записи: Dapper сопоставляет колонки со
    // свойствами по имени, как у остальных строк сервиса.
    private sealed class SummaryRow
    {
        public Guid SummaryId { get; init; }

        public DateTime SummarizedAt { get; init; }

        public string[] RecordIds { get; init; } = [];

        public StoredSummary Stored() =>
            new(SummaryId, new DateTimeOffset(DateTime.SpecifyKind(SummarizedAt, DateTimeKind.Utc)), RecordIds);
    }

    private sealed class SetRow
    {
        public string[] RecordIds { get; init; } = [];
    }

    private sealed class NeighbourRow
    {
        public Guid? Older { get; init; }

        public Guid? Newer { get; init; }
    }
}

/// <summary>Закрытый час: сводка и сколько фактов она дала.</summary>
public sealed record ClosedSummary(StoredSummary Summary, FactCount Facts);

/// <summary>Сводка и её соседи по времени у той же поверхности.</summary>
public sealed record SummaryWithNeighbours(StoredSummary Summary, Guid? Older, Guid? Newer);
