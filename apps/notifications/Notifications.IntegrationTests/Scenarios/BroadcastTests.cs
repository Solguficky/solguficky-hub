using Grpc.Core;
using Notifications.Broadcasts;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Ручные рассылки от команды до строки outbox: право спрашивается у
/// владельца ресурса, ключ идемпотентности принимается, аудитория
/// разворачивается по категориям в адресные факты тем же путём, что и
/// автоматические поводы.
/// </summary>
public class BroadcastTests
{
    private static readonly AuthorityAnswer Denied = new(AuthorityVerdict.Denied, "stub");
    private static readonly AuthorityAnswer Unavailable = new(AuthorityVerdict.Unavailable, "stub");

    private static string NewId() => Guid.CreateVersion7().ToString();

    private static CallOptions Chain(string requestId) =>
        new(new Metadata { { "x-request-id", requestId }, { "x-use-case", "broadcast" } },
            cancellationToken: TestContext.Current.CancellationToken);

    private static CallOptions Plain => new(cancellationToken: TestContext.Current.CancellationToken);

    private static BroadcastToMeetupSubscribersRequest ToMeetup(Guid author, string meetupId, string id, string body = "Переносимся на час") =>
        new() { IdentityId = author.ToString(), MeetupId = meetupId, Id = id, Body = body };

    private static BroadcastToCommunityRequest ToCommunity(Guid author, string id, string body = "Общий сбор") =>
        new() { IdentityId = author.ToString(), Id = id, Body = body };

    /// <summary>
    /// Сообщение организатора получает подписчик с включённой категорией — по
    /// умолчанию, глобально или у сходки. Выключивший её у сходки или глобально,
    /// неподписанный и заблокированный факта не получают.
    /// </summary>
    [Fact]
    public async Task When_OrganizerBroadcasts_Expect_OneFactPerSubscriberWithCategoryOn()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db, "Сходка у реки");
        var author = await Person(env.Db, "admin");

        var byDefault = await Person(env.Db, "member");
        var overriddenOn = await Person(env.Db, "member");
        var offHere = await Person(env.Db, "member");
        var offGlobally = await Person(env.Db, "member");
        var blocked = await Person(env.Db, blocked: true, "member");
        var notSubscribed = await Person(env.Db, "member");

        foreach (var person in new[] { byDefault, overriddenOn, offHere, offGlobally, blocked })
        {
            await Subscribe(env.Db, person, meetupId);
        }

        await Preference(env.Db, overriddenOn, null, "organizer_message", enabled: false);
        await Preference(env.Db, overriddenOn, meetupId, "organizer_message", enabled: true);
        await Preference(env.Db, offHere, meetupId, "organizer_message", enabled: false);
        await Preference(env.Db, offGlobally, null, "organizer_message", enabled: false);

        var id = NewId();
        var requestId = NewId();

        var accepted = await env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(author, meetupId, id), Chain(requestId));

        accepted.Id.ShouldBe(id);
        accepted.Created.ShouldBeTrue();
        accepted.AcceptedAt.ShouldNotBeNullOrEmpty();

        var facts = await env.Facts(id);
        facts.Select(fact => fact.RecipientId).ShouldBe(new[] { byDefault, overriddenOn }, ignoreOrder: true);
        facts.ShouldAllBe(fact => fact.Type == "organizer_message");
        facts.ShouldAllBe(fact => fact.MeetupId == Guid.Parse(meetupId));
        facts.ShouldAllBe(fact => fact.RequestId == requestId);
        notSubscribed.ShouldNotBeOneOf(facts.Select(fact => fact.RecipientId).ToArray());

        var message = facts[0].Parsed();
        message.TypeCase.ShouldBe(Notification.TypeOneofCase.OrganizerMessage);
        message.OrganizerMessage.Body.ShouldBe("Переносимся на час");
        message.OrganizerMessage.SenderId.ShouldBe(author.ToString());
        message.OrganizerMessage.Meetup.Id.ShouldBe(meetupId);
        message.OrganizerMessage.Meetup.Title.ShouldBe("Сходка у реки");
        message.Cause.CommandRequestId.ShouldBe(id);
        message.RequestId.ShouldBe(requestId);
        message.HasNotAfter.ShouldBeTrue();

        // Спросили владельца сходки, о нужном человеке и с цепочкой команды.
        env.Owners.Asked.ShouldHaveSingleItem().ShouldBe(("meetups", author, (Guid?)Guid.Parse(meetupId), (string?)requestId));
    }

    [Fact]
    public async Task When_StrangerBroadcastsToMeetup_Expect_PermissionDeniedAndNothingAccepted()
    {
        await using var env = await BroadcastsUnderTest.Start();
        env.Owners.Meetups = Denied;
        var meetupId = await Meetup(env.Db);
        var subscriber = await Person(env.Db, "member");
        await Subscribe(env.Db, subscriber, meetupId);
        var id = NewId();

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(Guid.CreateVersion7(), meetupId, id), Plain).ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.PermissionDenied);
        (await env.Facts(id)).ShouldBeEmpty();
        (await env.Accepted()).ShouldBe(0);
    }

    /// <summary>
    /// Отказ по праву не зависит от того, знает ли сходку реплика: различие
    /// «сходки нет» Notifications из своей реплики не восполняет.
    /// </summary>
    [Fact]
    public async Task When_StrangerBroadcastsToUnknownMeetup_Expect_SameDenial()
    {
        await using var env = await BroadcastsUnderTest.Start();
        env.Owners.Meetups = Denied;

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(Guid.CreateVersion7(), NewId(), NewId()), Plain).ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.PermissionDenied);
    }

    [Fact]
    public async Task When_OwnerUnavailable_Expect_UnavailableAndNothingAccepted()
    {
        await using var env = await BroadcastsUnderTest.Start();
        env.Owners.Meetups = Unavailable;
        env.Owners.Identity = Unavailable;
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, "admin");

        var toMeetup = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(author, meetupId, NewId()), Plain).ResponseAsync);
        var toCommunity = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToCommunityAsync(ToCommunity(author, NewId()), Plain).ResponseAsync);

        toMeetup.StatusCode.ShouldBe(StatusCode.Unavailable);
        toCommunity.StatusCode.ShouldBe(StatusCode.Unavailable);
        (await env.Accepted()).ShouldBe(0);
    }

    /// <summary>
    /// Повтор с тем же id и тем же содержимым отвечает моментом первого приёма
    /// и второго разворота не делает — даже если аудитория за это время выросла.
    /// </summary>
    [Fact]
    public async Task When_BroadcastRepeatedWithSameContent_Expect_NotCreatedAndNoSecondExpansion()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, "admin");
        var early = await Person(env.Db, "member");
        await Subscribe(env.Db, early, meetupId);
        var id = NewId();

        var first = await env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(author, meetupId, id), Plain);

        var late = await Person(env.Db, "member");
        await Subscribe(env.Db, late, meetupId);
        var repeated = await env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(author, meetupId, id), Chain(NewId()));

        repeated.Created.ShouldBeFalse();
        repeated.AcceptedAt.ShouldBe(first.AcceptedAt);
        (await env.Facts(id)).ShouldHaveSingleItem().RecipientId.ShouldBe(early);
    }

    [Fact]
    public async Task When_IdReusedWithDifferentBody_Expect_AlreadyExists()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, "admin");
        var id = NewId();

        await env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(author, meetupId, id), Plain);

        var otherBody = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(author, meetupId, id, "Другой текст"), Plain).ResponseAsync);
        var otherKind = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToCommunityAsync(ToCommunity(author, id, "Переносимся на час"), Plain).ResponseAsync);

        otherBody.StatusCode.ShouldBe(StatusCode.AlreadyExists);
        otherKind.StatusCode.ShouldBe(StatusCode.AlreadyExists);
    }

    /// <summary>
    /// Meetups подтвердил право, а реплика сходки ещё не знает: карточку
    /// собрать не из чего. Ответ — «не сейчас», ключ не принят, и повтор с тем
    /// же id проходит, когда реплика догнала.
    /// </summary>
    [Fact]
    public async Task When_MeetupNotReplicatedYet_Expect_UnavailableThenRepeatSucceeds()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var author = await Person(env.Db, "admin");
        var meetupId = NewId();
        var id = NewId();

        var early = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(author, meetupId, id), Plain).ResponseAsync);

        early.StatusCode.ShouldBe(StatusCode.Unavailable);
        (await env.Accepted()).ShouldBe(0);

        await Execute(
            env.Db,
            """
            INSERT INTO meetup_replica (
                meetup_id, version, author, title, description, venue, kind, calendar_link,
                lifecycle, visibility, schedule_form, occurred_at, applied_at)
            VALUES (@Id, 1, @Id, 'Сходка', '', '', '', '', 'planned', 'visible', 'no_date', now(), now());
            """,
            new { Id = Guid.Parse(meetupId) });

        var later = await env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(author, meetupId, id), Plain);
        later.Created.ShouldBeTrue();
    }

    /// <summary>
    /// Объявление получает круг хаба с включённой категорией. Внешний круг
    /// аукциона, заблокированный и выключивший категорию — нет.
    /// </summary>
    [Fact]
    public async Task When_AdministratorAnnounces_Expect_OneFactPerHubMemberWithCategoryOn()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var author = await Person(env.Db, "admin");
        var member = await Person(env.Db, "member");
        var maintainer = await Person(env.Db, "maintainer");
        var outer = await Person(env.Db, "public");
        var blocked = await Person(env.Db, blocked: true, "member");
        var off = await Person(env.Db, "member");
        await Preference(env.Db, off, null, "community_announcement", enabled: false);
        var id = NewId();

        var accepted = await env.Client.BroadcastToCommunityAsync(ToCommunity(author, id), Plain);

        accepted.Created.ShouldBeTrue();
        var facts = await env.Facts(id);
        facts.Select(fact => fact.RecipientId).ShouldBe(new[] { author, member, maintainer }, ignoreOrder: true);
        facts.ShouldAllBe(fact => fact.Type == "community_announcement" && fact.MeetupId == null);
        new[] { outer, blocked, off }.ShouldAllBe(person => facts.All(fact => fact.RecipientId != person));

        var message = facts[0].Parsed();
        message.TypeCase.ShouldBe(Notification.TypeOneofCase.CommunityAnnouncement);
        message.CommunityAnnouncement.Body.ShouldBe("Общий сбор");
        message.CommunityAnnouncement.SenderId.ShouldBe(author.ToString());
        message.Cause.CommandRequestId.ShouldBe(id);
        message.HasRequestId.ShouldBeFalse();

        env.Owners.Asked.ShouldHaveSingleItem().Owner.ShouldBe("identity");
    }

    [Fact]
    public async Task When_NonAdministratorAnnounces_Expect_PermissionDenied()
    {
        await using var env = await BroadcastsUnderTest.Start();
        env.Owners.Identity = Denied;
        await Person(env.Db, "member");
        var id = NewId();

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToCommunityAsync(ToCommunity(Guid.CreateVersion7(), id), Plain).ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.PermissionDenied);
        (await env.Facts(id)).ShouldBeEmpty();
    }

    /// <summary>
    /// Форма запроса проверяется до права: кривой запрос не стоит вызова
    /// владельца и не доходит до ключа.
    /// </summary>
    [Fact]
    public async Task When_BodyEmpty_Expect_InvalidArgumentBeforeOwnerIsAsked()
    {
        await using var env = await BroadcastsUnderTest.Start();
        var author = await Person(env.Db, "admin");

        var refused = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToCommunityAsync(ToCommunity(author, NewId(), body: ""), Plain).ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.InvalidArgument);
        env.Owners.Asked.ShouldBeEmpty();
    }

    /// <summary>
    /// Composition root как есть, без адресов Meetups и Identity: рассылка
    /// отвечает отказом, а не уходит без проверки права.
    /// </summary>
    [Fact]
    public async Task When_OwnersNotConfigured_Expect_UnavailableAndNothingAccepted()
    {
        await using var env = await BroadcastsUnderTest.StartWithoutOwners();
        var meetupId = await Meetup(env.Db);
        var author = await Person(env.Db, "admin");

        var toMeetup = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToMeetupSubscribersAsync(ToMeetup(author, meetupId, NewId()), Plain).ResponseAsync);
        var toCommunity = await Should.ThrowAsync<RpcException>(() =>
            env.Client.BroadcastToCommunityAsync(ToCommunity(author, NewId()), Plain).ResponseAsync);

        toMeetup.StatusCode.ShouldBe(StatusCode.Unavailable);
        toCommunity.StatusCode.ShouldBe(StatusCode.Unavailable);
        (await env.Accepted()).ShouldBe(0);
    }
}
