using Grpc.Core;
using Grpc.Net.Client;
using Microsoft.Extensions.Options;
using Notifications.Domain;
using Notifications.Facts;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.ReleaseNotes;
using Notifications.Reminders;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Выпуск «Что нового» как данные среды (PER-628, ADR-069, п. 2–5) на настоящей
/// базе. Время двигается моментом, который сценарий передаёт хранилищу, а в
/// хосте — сдвигом <c>next_summary_at</c> в базе.
/// </summary>
public class ReleaseNotesTests
{
    private static readonly ReleaseSurface Hub = ReleaseSurface.Hub;

    // 11:00 по Москве: первый час сводки — полдень того же дня.
    private static readonly DateTimeOffset Reported = new(2026, 10, 20, 8, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset Noon(int day) => new DateTimeOffset(2026, 10, 20, 9, 0, 0, TimeSpan.Zero).AddDays(day);

    [Fact]
    public async Task When_FirstReport_Expect_WholeSetAnnouncedWithoutSummary()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        await Person(db, MemberHolding);

        (await store.Report(Hub, ["first", "second"], Reported, Cancellation)).ShouldBeTrue();

        (await store.Close(Hub, Noon(0), Cancellation)).ShouldBeNull();
        (await Count(db, "release_summary")).ShouldBe(0);
        (await Count(db, "notification")).ShouldBe(0);
    }

    /// <summary>
    /// Пустой первый набор — тоже первый приём: следующая запись объявляется
    /// сводкой, а не гасится вторым «первым приёмом» (ADR-069, п. 3).
    /// </summary>
    [Fact]
    public async Task When_FirstReportEmpty_Expect_NextRecordSummarized()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var member = await Person(db, MemberHolding);

        (await store.Report(Hub, [], Reported, Cancellation)).ShouldBeTrue();
        (await store.Close(Hub, Noon(0), Cancellation)).ShouldBeNull();
        (await store.Report(Hub, ["first"], Noon(0).AddHours(1), Cancellation)).ShouldBeFalse();

        var closed = (await store.Close(Hub, Noon(1), Cancellation)).ShouldNotBeNull();
        closed.Summary.RecordIds.ShouldBe(["first"]);
        var fact = (await StoredFacts(db)).ShouldHaveSingleItem();
        fact.RecipientId.ShouldBe(member.ToString());
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.ReleaseSummary);
        fact.Cause.ReleaseSummaryId.ShouldBe(closed.Summary.SummaryId.ToString("D"));
        fact.ReleaseSummary.RecordIds.ShouldBe(["first"]);
    }

    [Fact]
    public async Task When_SameSetReportedAgain_Expect_NoNewSummary()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        await Person(db, MemberHolding);
        await store.Report(Hub, ["old"], Reported, Cancellation);
        await store.Report(Hub, ["old", "new"], Reported.AddMinutes(1), Cancellation);
        await store.Report(Hub, ["old", "new"], Reported.AddMinutes(2), Cancellation);

        (await store.Close(Hub, Noon(0), Cancellation)).ShouldNotBeNull().Summary.RecordIds.ShouldBe(["new"]);

        // Повтор того же набора после сводки ничего не добавляет.
        await store.Report(Hub, ["old", "new"], Noon(0).AddHours(1), Cancellation);
        (await store.Close(Hub, Noon(1), Cancellation)).ShouldBeNull();
        (await Count(db, "release_summary")).ShouldBe(1);
        (await Count(db, "notification")).ShouldBe(1);
    }

    /// <summary>
    /// Сводка раз в сутки: закрытый час переносится на завтра и без новых
    /// записей, а запись, пришедшая после сводки, ждёт следующего часа.
    /// </summary>
    [Fact]
    public async Task When_HourClosed_Expect_NextSummaryOnlyNextDayAndOnlyWithNewRecords()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        await Person(db, MemberHolding);
        await store.Report(Hub, ["base"], Reported, Cancellation);

        // Новых нет — сводки нет, но час закрыт.
        (await store.Close(Hub, Noon(0), Cancellation)).ShouldBeNull();
        (await store.Due(Noon(0), Cancellation)).ShouldBeEmpty();

        await store.Report(Hub, ["base", "late"], Noon(0).AddMinutes(5), Cancellation);
        (await store.Close(Hub, Noon(0).AddMinutes(10), Cancellation)).ShouldBeNull();
        (await store.Due(Noon(1).AddSeconds(-1), Cancellation)).ShouldBeEmpty();

        (await store.Due(Noon(1), Cancellation)).ShouldBe([Hub]);
        (await store.Close(Hub, Noon(1), Cancellation)).ShouldNotBeNull().Summary.RecordIds.ShouldBe(["late"]);
        (await store.Close(Hub, Noon(2), Cancellation)).ShouldBeNull();
        (await Count(db, "release_summary")).ShouldBe(1);
    }

    /// <summary>
    /// Строка поверхности, которую схема допускает раньше кода, проход не
    /// роняет: час хаба закрывается, а чужая поверхность ждёт своего кода.
    /// </summary>
    [Fact]
    public async Task When_SurfaceUnknownToCode_Expect_HubSummaryStillCloses()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        await store.Report(Hub, [], Reported, Cancellation);
        await store.Report(Hub, ["new"], Reported.AddMinutes(1), Cancellation);
        await Execute(db, """
            INSERT INTO release_surface (surface, first_reported_at, reported_at, record_ids, next_summary_at)
            VALUES ('auction', @Reported, @Reported, '{}', @Reported);
            """, new { Reported = Reported.UtcDateTime });

        (await store.Due(Noon(0), Cancellation)).ShouldBe([Hub]);
        (await store.Close(Hub, Noon(0), Cancellation)).ShouldNotBeNull().Summary.RecordIds.ShouldBe(["new"]);
    }

    /// <summary>Записи одного отчёта объявляются в порядке образа.</summary>
    [Fact]
    public async Task When_SeveralNewRecords_Expect_SummaryInImageOrder()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        await store.Report(Hub, [], Reported, Cancellation);
        await store.Report(Hub, ["zeta", "alpha"], Reported.AddMinutes(1), Cancellation);
        await store.Report(Hub, ["zeta", "alpha", "beta"], Reported.AddMinutes(2), Cancellation);

        (await store.Close(Hub, Noon(0), Cancellation)).ShouldNotBeNull()
            .Summary.RecordIds.ShouldBe(["zeta", "alpha", "beta"]);
    }

    /// <summary>
    /// Откат образа убирает запись из последнего набора: она не объявляется и
    /// выходит, когда выкладка снова её несёт (ADR-069, п. 4).
    /// </summary>
    [Fact]
    public async Task When_RecordRolledBack_Expect_AnnouncedAfterRedeploy()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        await Person(db, MemberHolding);
        await store.Report(Hub, ["base"], Reported, Cancellation);
        await store.Report(Hub, ["base", "rolled"], Reported.AddMinutes(1), Cancellation);
        await store.Report(Hub, ["base"], Reported.AddMinutes(2), Cancellation);

        (await store.Close(Hub, Noon(0), Cancellation)).ShouldBeNull();

        await store.Report(Hub, ["base", "rolled"], Noon(0).AddHours(1), Cancellation);
        (await store.Close(Hub, Noon(1), Cancellation)).ShouldNotBeNull().Summary.RecordIds.ShouldBe(["rolled"]);
    }

    /// <summary>
    /// Адресаты — держатели права хаба с включённой категорией; доставляет бот
    /// хаба. Выключивший категорию, гость без права хаба и заблокированный
    /// сводки не получают.
    /// </summary>
    [Fact]
    public async Task When_Summarized_Expect_FactOnlyToHubHoldersWithCategoryOn()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source, defaultEnabled: true);
        var member = await Person(db, MemberHolding);
        var silenced = await Person(db, MemberHolding);
        await Person(db, GuestHolding);
        await Person(db, blocked: true, MemberHolding);
        await Preference(db, silenced, null, "release_notes", enabled: false);
        await store.Report(Hub, [], Reported, Cancellation);
        await store.Report(Hub, ["new"], Reported.AddMinutes(1), Cancellation);

        var closed = (await store.Close(Hub, Noon(0), Cancellation)).ShouldNotBeNull();

        closed.Facts.ShouldBe(new FactCount(1, 1));
        (await StoredFacts(db)).ShouldHaveSingleItem().RecipientId.ShouldBe(member.ToString());
        (await Read<string>(db, "SELECT delivery_surface FROM notification;")).ShouldBe("hub");
    }

    /// <summary>
    /// Умолчание «выкл» (прод): не трогавший переключатель сводку не получает,
    /// включивший сам — получает. При «вкл» (stage) не трогавший получает.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task When_DefaultFromEnvironment_Expect_UntouchedFollowsIt(bool defaultEnabled)
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source, defaultEnabled);
        var untouched = await Person(db, MemberHolding);
        var opted = await Person(db, MemberHolding);
        await Preference(db, opted, null, "release_notes", enabled: true);
        await store.Report(Hub, [], Reported, Cancellation);
        await store.Report(Hub, ["new"], Reported.AddMinutes(1), Cancellation);

        await store.Close(Hub, Noon(0), Cancellation);

        var recipients = (await StoredFacts(db)).Select(fact => fact.RecipientId).ToArray();
        recipients.ShouldContain(opted.ToString());
        recipients.Contains(untouched.ToString()).ShouldBe(defaultEnabled);
    }

    [Fact]
    public async Task When_SummariesPaged_Expect_NewestFirstAndNeighbours()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        await store.Report(Hub, [], Reported, Cancellation);
        var ids = new List<Guid>();
        for (var day = 0; day < 3; day++)
        {
            await store.Report(Hub, [.. Enumerable.Range(0, day + 1).Select(n => $"record-{n}")],
                Noon(day).AddHours(-1), Cancellation);
            ids.Add((await store.Close(Hub, Noon(day), Cancellation)).ShouldNotBeNull().Summary.SummaryId);
        }

        var (first, more) = await store.Page(Hub, before: null, limit: 2, Cancellation);
        first.Select(summary => summary.SummaryId).ShouldBe([ids[2], ids[1]]);
        more.ShouldBeTrue();
        var (rest, end) = await store.Page(Hub, first[^1].SummaryId, limit: 2, Cancellation);
        rest.Select(summary => summary.SummaryId).ShouldBe([ids[0]]);
        end.ShouldBeFalse();

        var middle = (await store.One(Hub, ids[1], Cancellation)).ShouldNotBeNull();
        middle.Summary.RecordIds.ShouldBe(["record-1"]);
        (middle.Older, middle.Newer).ShouldBe((ids[0], ids[2]));
        var oldest = (await store.One(Hub, ids[0], Cancellation)).ShouldNotBeNull();
        (oldest.Older, oldest.Newer).ShouldBe(((Guid?)null, ids[1]));
        (await store.One(Hub, Guid.CreateVersion7(), Cancellation)).ShouldBeNull();
    }

    /// <summary>
    /// Через границу: бот хаба отчитывается набором, пропущенный час подбирает
    /// sweeper работающего сервиса, а сводка читается страницей и по
    /// идентификатору. Бот аукциона своей поверхности пока не имеет.
    /// </summary>
    [Fact]
    public async Task When_HourMissedInRunningService_Expect_SweeperSummarizesAndBotReadsIt()
    {
        using var db = Database();
        await using var silo = await SiloUnderTest.Start(db.ConnectionString,
            "--Notifications:ReleaseNotes:SweepPeriod=00:00:01",
            $"--{CategoryDefaults.ReleaseNotesVariable}=true");
        using var channel = GrpcChannel.ForAddress(silo.Address);
        var client = new NotificationsService.NotificationsServiceClient(SiloUnderTest.AsBot(channel));
        var member = await Person(db, MemberHolding);

        await client.ReportReleaseNotesAsync(new ReportReleaseNotesRequest { RecordIds = { "old" } },
            cancellationToken: Cancellation);
        await client.ReportReleaseNotesAsync(new ReportReleaseNotesRequest { RecordIds = { "old", "new" } },
            cancellationToken: Cancellation);
        await client.ReportReleaseNotesAsync(new ReportReleaseNotesRequest { RecordIds = { "old", "new" } },
            cancellationToken: Cancellation);

        await Execute(db, "UPDATE release_surface SET next_summary_at = now() - interval '1 hour';", new { });
        var fact = (await Eventually(() => StoredFacts(db), facts => facts.Count == 1)).Single();
        fact.RecipientId.ShouldBe(member.ToString());

        var page = await client.ListReleaseSummariesAsync(new ListReleaseSummariesRequest(),
            cancellationToken: Cancellation);
        var summary = page.Summaries.ShouldHaveSingleItem();
        summary.RecordIds.ShouldBe(["new"]);
        page.NextPageToken.ShouldBeEmpty();
        // Факт и чтение называют одну сводку одинаково, вплоть до момента.
        summary.ShouldBe(fact.ReleaseSummary);

        var one = await client.GetReleaseSummaryAsync(new GetReleaseSummaryRequest { SummaryId = summary.SummaryId },
            cancellationToken: Cancellation);
        one.Summary.ShouldBe(summary);
        one.HasOlderSummaryId.ShouldBeFalse();
        one.HasNewerSummaryId.ShouldBeFalse();

        var unknown = await Should.ThrowAsync<RpcException>(() => client.GetReleaseSummaryAsync(
            new GetReleaseSummaryRequest { SummaryId = Guid.CreateVersion7().ToString("D") },
            cancellationToken: Cancellation).ResponseAsync);
        unknown.StatusCode.ShouldBe(StatusCode.NotFound);

        // Час закрыт: следующий проход второй сводки не даёт.
        (await Read<bool>(db, "SELECT next_summary_at > now() FROM release_surface;")).ShouldBeTrue();
    }

    private static async Task<T> Read<T>(IsolatedDatabase db, string sql)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return (await Dapper.SqlMapper.ExecuteScalarAsync<T>(connection, sql))!;
    }

    private static ReleaseNotesStore Store(NpgsqlDataSource source, bool defaultEnabled = true) =>
        new(source, CommunityTime.Parse("Europe/Moscow"), new CategoryDefaults(defaultEnabled),
            Options.Create(new ReleaseNotesOptions()), Options.Create(new FactOptions()));
}
