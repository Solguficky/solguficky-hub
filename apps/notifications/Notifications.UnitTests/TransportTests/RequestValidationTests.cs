using Grpc.Core;
using Notifications.Transport;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.TransportTests;

/// <summary>
/// Разбор входящих полей на границе. Форма идентификатора и словарь категорий —
/// первые проверки запроса, и их отказ по контракту всегда
/// <c>INVALID_ARGUMENT</c>.
/// </summary>
public class RequestValidationTests
{
    // Канонический UUIDv7: версия 7, вариант RFC 9562 (10xx), строчные буквы.
    private const string CanonicalUuidV7 = "01932b3c-4d5e-7f80-8123-456789abcdef";

    [Fact]
    public void IdentityId_CanonicalUuidV7_IsAccepted()
    {
        RequestValidation.IdentityId(CanonicalUuidV7).ToString("D").ShouldBe(CanonicalUuidV7);
    }

    [Fact]
    public void IdentityId_UpperCase_IsRejected()
    {
        // Guid.TryParseExact формата "D" принимает верхний регистр, а
        // канонический вид — нижний, поэтому разбора здесь мало.
        Code(() => RequestValidation.IdentityId(CanonicalUuidV7.ToUpperInvariant()))
            .ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public void IdentityId_WithoutHyphens_IsRejected()
    {
        Code(() => RequestValidation.IdentityId(CanonicalUuidV7.Replace("-", string.Empty)))
            .ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public void IdentityId_Empty_IsRejected()
    {
        Code(() => RequestValidation.IdentityId(string.Empty)).ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public void IdentityId_UuidOfAnotherVersion_IsRejected()
    {
        // Четвёртая версия разбирается как Guid и каноническую форму проходит:
        // формат "D" о смысле битов ничего не знает.
        Code(() => RequestValidation.IdentityId("01932b3c-4d5e-4f80-8123-456789abcdef"))
            .ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public void IdentityId_UuidV7WithForeignVariant_IsRejected()
    {
        // Верная версия и чужой вариант: по RFC 9562 это не UUIDv7, и версии
        // одной мало, чтобы в этом убедиться.
        Code(() => RequestValidation.IdentityId("01932b3c-4d5e-7f80-c123-456789abcdef"))
            .ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public void Category_Unspecified_IsRejected()
    {
        // Неизвестная категория отвергается, а не отбрасывается: она и есть цель
        // команды, и тихо принять запрос, который ничего не меняет, нельзя.
        Code(() => RequestValidation.Category(NotificationCategory.Unspecified))
            .ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public void Category_ValueOutsideDictionary_IsRejected()
    {
        Code(() => RequestValidation.Category((NotificationCategory)42)).ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public void MeetupScopedCategory_GlobalOnlyCategory_IsRejected()
    {
        Code(() => RequestValidation.MeetupScopedCategory(NotificationCategory.MeetupPublished))
            .ShouldBe(StatusCode.InvalidArgument);

        Code(() => RequestValidation.MeetupScopedCategory(NotificationCategory.CommunityAnnouncement))
            .ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public void MeetupScopedCategory_CategoryAMeetupCanHold_IsAccepted()
    {
        RequestValidation.MeetupScopedCategory(NotificationCategory.MeetupReminder)
            .ShouldBe(NotificationCategory.MeetupReminder);
    }

    [Fact]
    public void BroadcastId_NotUuidV7_IsRejected()
    {
        Code(() => RequestValidation.BroadcastId("01932b3c-4d5e-4f80-8123-456789abcdef"))
            .ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public void Body_Empty_IsRejected()
    {
        Code(() => RequestValidation.Body(string.Empty)).ShouldBe(StatusCode.InvalidArgument);
    }

    /// <summary>Что писать, решает автор: граница пробелы не отвергает и не обрезает.</summary>
    [Fact]
    public void Body_Whitespace_IsAcceptedVerbatim()
    {
        RequestValidation.Body("  ").ShouldBe("  ");
    }

    /// <summary>
    /// Код объявленного отказа. Неожиданное исключение наружу не глотается:
    /// тест, поймавший всё подряд, зеленел бы и на сломанной границе.
    /// </summary>
    private static StatusCode Code(Action call)
    {
        try
        {
            call();
        }
        catch (RpcException declined)
        {
            return declined.StatusCode;
        }

        throw new InvalidOperationException("call was expected to be declined");
    }
}
