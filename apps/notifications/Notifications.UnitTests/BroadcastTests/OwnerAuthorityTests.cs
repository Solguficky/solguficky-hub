using Grpc.Core;
using Identity.V1;
using Meetups.V1;
using Notifications.Broadcasts;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.BroadcastTests;

/// <summary>
/// Запрос к владельцам права и сведение их ответа к вердикту — без сервера:
/// отправка подменена делегатом, который запоминает запрос и отвечает
/// заданным исходом.
/// </summary>
public class OwnerAuthorityTests
{
    private static readonly Guid Author = Guid.CreateVersion7();
    private static readonly Guid MeetupId = Guid.CreateVersion7();
    private static readonly DateTimeOffset Now = new(2026, 9, 26, 12, 0, 0, TimeSpan.Zero);

    private static Forwarded Chain(DateTime? deadline = null, string? requestId = "req-1", string? useCase = "broadcast") =>
        new(requestId, useCase, deadline ?? DateTime.MaxValue, CancellationToken.None);

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class Recorded
    {
        public CheckMeetupAuthorityRequest? Meetups { get; set; }

        public CheckGlobalRoleRequest? Identity { get; set; }

        public Metadata? Headers { get; set; }

        public DateTime Deadline { get; set; }
    }

    private static OwnerAuthority Authority(Recorded seen, Func<Task>? meetupsOutcome = null, Func<Task<bool>>? identityOutcome = null) =>
        new(
            async (request, headers, deadline, _) =>
            {
                seen.Meetups = request;
                seen.Headers = headers;
                seen.Deadline = deadline;
                await (meetupsOutcome ?? (() => Task.CompletedTask))();
                return new MeetupAuthority();
            },
            async (request, headers, deadline, _) =>
            {
                seen.Identity = request;
                seen.Headers = headers;
                seen.Deadline = deadline;
                return new CheckGlobalRoleResponse { Granted = await (identityOutcome ?? (() => Task.FromResult(true)))() };
            },
            new FixedClock(Now));

    private static Func<Task> Fails(StatusCode code) => () => throw new RpcException(new Status(code, "stub"));

    [Fact]
    public async Task MeetupBroadcast_Granted_AsksMeetupsForAdministratorRelation()
    {
        var seen = new Recorded();

        var answer = await Authority(seen).MeetupBroadcast(Author, MeetupId, Chain());

        answer.Verdict.ShouldBe(AuthorityVerdict.Granted);
        seen.Meetups!.IdentityId.ShouldBe(Author.ToString("D"));
        seen.Meetups.Id.ShouldBe(MeetupId.ToString("D"));
        seen.Meetups.AcceptedRelations.ShouldBe([MeetupRelation.CommunityAdministrator]);
    }

    [Theory]
    [InlineData(StatusCode.PermissionDenied, AuthorityVerdict.Denied)]
    [InlineData(StatusCode.NotFound, AuthorityVerdict.Denied)]
    [InlineData(StatusCode.Unavailable, AuthorityVerdict.Unavailable)]
    [InlineData(StatusCode.DeadlineExceeded, AuthorityVerdict.Unavailable)]
    [InlineData(StatusCode.Cancelled, AuthorityVerdict.Unavailable)]
    [InlineData(StatusCode.InvalidArgument, AuthorityVerdict.Failed)]
    [InlineData(StatusCode.Internal, AuthorityVerdict.Failed)]
    public async Task MeetupBroadcast_MeetupsRefuses_MapsStatusToVerdict(StatusCode code, AuthorityVerdict expected)
    {
        var answer = await Authority(new Recorded(), meetupsOutcome: Fails(code)).MeetupBroadcast(Author, MeetupId, Chain());

        answer.Verdict.ShouldBe(expected);
    }

    [Fact]
    public async Task CommunityAnnouncement_Granted_AsksIdentityForAdminRoleOnly()
    {
        var seen = new Recorded();

        var answer = await Authority(seen).CommunityAnnouncement(Author, Chain());

        answer.Verdict.ShouldBe(AuthorityVerdict.Granted);
        seen.Identity!.IdentityId.ShouldBe(Author.ToString("D"));
        seen.Identity.AcceptedRoles.ShouldBe([GlobalRole.Admin]);
    }

    [Fact]
    public async Task CommunityAnnouncement_RoleNotHeld_IsDenied()
    {
        var answer = await Authority(new Recorded(), identityOutcome: () => Task.FromResult(false))
            .CommunityAnnouncement(Author, Chain());

        answer.Verdict.ShouldBe(AuthorityVerdict.Denied);
    }

    [Theory]
    [InlineData(StatusCode.NotFound, AuthorityVerdict.Denied)]
    [InlineData(StatusCode.Unavailable, AuthorityVerdict.Unavailable)]
    [InlineData(StatusCode.DeadlineExceeded, AuthorityVerdict.Unavailable)]
    [InlineData(StatusCode.PermissionDenied, AuthorityVerdict.Failed)]
    [InlineData(StatusCode.Internal, AuthorityVerdict.Failed)]
    public async Task CommunityAnnouncement_IdentityRefuses_MapsStatusToVerdict(StatusCode code, AuthorityVerdict expected)
    {
        var answer = await Authority(
                new Recorded(),
                identityOutcome: () => throw new RpcException(new Status(code, "stub")))
            .CommunityAnnouncement(Author, Chain());

        answer.Verdict.ShouldBe(expected);
    }

    /// <summary>Адрес владельца не задан — «не подтвердить», а не разрешение.</summary>
    [Fact]
    public async Task MeetupBroadcast_MeetupsUnconfigured_IsUnavailable()
    {
        var authority = new OwnerAuthority(null, null, new FixedClock(Now));

        (await authority.MeetupBroadcast(Author, MeetupId, Chain())).Verdict.ShouldBe(AuthorityVerdict.Unavailable);
    }

    /// <inheritdoc cref="MeetupBroadcast_MeetupsUnconfigured_IsUnavailable" />
    [Fact]
    public async Task CommunityAnnouncement_IdentityUnconfigured_IsUnavailable()
    {
        var authority = new OwnerAuthority(null, null, new FixedClock(Now));

        (await authority.CommunityAnnouncement(Author, Chain())).Verdict.ShouldBe(AuthorityVerdict.Unavailable);
    }

    [Fact]
    public async Task MeetupBroadcast_NoCallerDeadline_BoundsCallByOwnDeadline()
    {
        var seen = new Recorded();

        await Authority(seen).MeetupBroadcast(Author, MeetupId, Chain());

        seen.Deadline.ShouldBe(Now.UtcDateTime + OwnerAuthority.CallDeadline);
    }

    [Fact]
    public async Task CommunityAnnouncement_CallerDeadlineShorter_UsesCallerDeadline()
    {
        var seen = new Recorded();
        var callers = Now.UtcDateTime.AddMilliseconds(500);

        await Authority(seen).CommunityAnnouncement(Author, Chain(deadline: callers));

        seen.Deadline.ShouldBe(callers);
    }

    [Fact]
    public async Task MeetupBroadcast_UseCaseMissing_ForwardsOnlyPresentHeaders()
    {
        var seen = new Recorded();

        await Authority(seen).MeetupBroadcast(Author, MeetupId, Chain(requestId: "req-7", useCase: null));

        seen.Headers!.GetValue("x-request-id").ShouldBe("req-7");
        seen.Headers.Get("x-use-case").ShouldBeNull();
    }
}
