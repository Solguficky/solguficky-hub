using Contour.E2ETests.Infrastructure;
using Identity.V1;
using Meetups.V1;
using Shouldly;
using Xunit;

namespace Contour.E2ETests.Scenarios;

/// <summary>
/// Один дымовой сценарий уровня L2: две деплоимые единицы вместе, включая
/// провод — транспорт, заголовки, кодирование Protobuf.
///
/// Роль администратора берётся настоящей выдачей через Identity, а не
/// подставляется в <c>Viewer</c> на клиенте. Подстановка сделала бы Identity
/// процессом, который просто запустился: сценарий остался бы зелёным при
/// сломанном хранении ролей, то есть проверял бы один Meetups — L1 в костюме L2.
///
/// Доменных инвариантов здесь нет намеренно: стандарт запрещает проверять на L2
/// то, что детерминированно проверяется на L0.
/// </summary>
[Collection(ContourCollection.Name)]
public sealed class MeetupDraftContourTests(ContourFixture contour)
{
    // Дедлайн на каждый вызов. Health-проба того же репозитория объясняет,
    // почему: сервис может отвечать на grpc.health.v1 и залипнуть на пуле
    // PostgreSQL, и без предела набор висит до отмены всей джобы, когда
    // выгрузка логов по `if: failure()` уже не выполняется.
    private static readonly TimeSpan CallDeadline = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task When_IdentityGrantedAdmin_Expect_MeetupsAcceptsDraftAndReturnsIt()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var seed = contour.Contour.Seed;

        // Идентификатор выводится из seed прогона: повторный запуск с тем же
        // CONTOUR_SEED воспроизводит вход целиком, а соседние прогоны не
        // сталкиваются.
        var telegramUserId = 6_000_000_000L + seed;

        var resolved = await contour.IdentityClient.ResolveIdentityAsync(
            new ResolveIdentityRequest { TelegramUserId = telegramUserId },
            deadline: Deadline(),
            cancellationToken: cancellationToken);

        resolved.IdentityId.ShouldNotBeNullOrWhiteSpace();
        resolved.Blocked.ShouldBeFalse();
        resolved.GlobalRoles.ShouldNotContain(GlobalRole.Admin);

        var granted = await contour.IdentityClient.GrantAdminRoleAsync(
            new GrantAdminRoleRequest { IdentityId = resolved.IdentityId },
            headers: contour.MaintainerCall(),
            deadline: Deadline(),
            cancellationToken: cancellationToken);

        granted.Changed.ShouldBeTrue();

        // Повторный резолв, а не сборка Viewer руками: роли для команды берутся
        // из ответа Identity, иначе выдача роли осталась бы непроверенной.
        var admin = await contour.IdentityClient.ResolveIdentityAsync(
            new ResolveIdentityRequest { TelegramUserId = telegramUserId },
            deadline: Deadline(),
            cancellationToken: cancellationToken);

        admin.GlobalRoles.ShouldContain(GlobalRole.Admin);

        var viewer = new Viewer { IdentityId = admin.IdentityId };
        viewer.GlobalRoles.AddRange(admin.GlobalRoles);

        var meetupId = MeetupIdentifier(seed);

        var created = await contour.MeetupsClient.CreateMeetupDraftAsync(
            new CreateMeetupDraftRequest { Viewer = viewer, Id = meetupId },
            deadline: Deadline(),
            cancellationToken: cancellationToken);

        created.Id.ShouldBe(meetupId);
        created.Author.ShouldBe(admin.IdentityId);
        created.Version.ShouldBeGreaterThan(0);

        var read = await contour.MeetupsClient.GetMeetupAsync(
            new GetMeetupRequest { Viewer = viewer, Id = meetupId },
            deadline: Deadline(),
            cancellationToken: cancellationToken);

        read.Id.ShouldBe(meetupId);
        read.Author.ShouldBe(admin.IdentityId);
        read.Version.ShouldBe(created.Version);
    }

    private static DateTime Deadline() => DateTime.UtcNow.Add(CallDeadline);

    /// <summary>
    /// UUIDv7, выведенный из seed. <c>Guid.CreateVersion7</c> берёт время и
    /// случайность, то есть ломал бы обещание воспроизводимости: половина входа
    /// менялась бы независимо от CONTOUR_SEED. Meetups проверяет только версию
    /// и вариант (<c>Contract.uuidV7</c>), а не осмысленность метки времени.
    /// </summary>
    private static string MeetupIdentifier(int seed)
    {
        var bytes = new byte[16];
        new Random(seed).NextBytes(bytes);

        // Раскладка big-endian по RFC 9562: версия — старший ниббл байта 6
        // (Guid.Version читает его из Data3), вариант 10xx — два старших бита
        // байта 8.
        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x70);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);

        return new Guid(bytes, bigEndian: true).ToString("D");
    }
}
