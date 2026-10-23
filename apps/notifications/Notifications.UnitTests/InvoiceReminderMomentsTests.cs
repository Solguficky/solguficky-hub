using Notifications.Reminders;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests;

/// <summary>
/// Моменты напоминания о счёте. Ядро чистое, поэтому весь набор идёт на L0 и
/// попадает в <c>just verify</c>: базы здесь нет, часов тоже.
/// </summary>
public class InvoiceReminderMomentsTests
{
    private static readonly TimeSpan FirstLead = TimeSpan.FromHours(12);

    private static readonly TimeSpan DueLead = TimeSpan.FromDays(1);

    private static readonly TimeSpan MinGap = TimeSpan.FromHours(1);

    private static readonly DateTimeOffset IssuedAt = new(2026, 10, 20, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void First_InvoiceRaised_LeadsTwelveHours()
    {
        InvoiceReminderMoments.First(IssuedAt, FirstLead).ShouldBe(IssuedAt.AddHours(12));
    }

    [Fact]
    public void Second_PaymentDueInSevenDays_LeadsADayBeforeIt()
    {
        var dueAt = IssuedAt.AddDays(7);

        InvoiceReminderMoments.Second(IssuedAt, dueAt, FirstLead, DueLead, MinGap)
            .ShouldBe(dueAt.AddDays(-1));
    }

    [Fact]
    public void Second_ShortPaymentTerm_DoesNotCollideWithTheFirst()
    {
        // Срок оплаты — любое число секунд от суток: «за сутки до срока» при
        // сроке в сутки совпало бы с первым напоминанием. Зазор отводит
        // второе напоминание от первого.
        var dueAt = IssuedAt.AddDays(1);

        var second = InvoiceReminderMoments.Second(IssuedAt, dueAt, FirstLead, DueLead, MinGap);

        second.ShouldBe(IssuedAt.AddHours(13));
        second.ShouldBeGreaterThan(InvoiceReminderMoments.First(IssuedAt, FirstLead));
    }

    [Fact]
    public void Second_ShortPaymentTerm_StaysBeforeThePaymentDeadline()
    {
        var dueAt = IssuedAt.AddDays(1);

        InvoiceReminderMoments.Second(IssuedAt, dueAt, FirstLead, DueLead, MinGap).ShouldBeLessThan(dueAt);
    }

    [Fact]
    public void For_FirstMomentBeforeTheDeadline_GivesTheMoment()
    {
        var dueAt = IssuedAt.AddDays(7);

        InvoiceReminderMoments.For(InvoiceReminderKind.AfterWin, IssuedAt, dueAt, FirstLead, DueLead, MinGap)
            .ShouldBe(IssuedAt.AddHours(12));
    }

    [Fact]
    public void For_MomentAfterTheDeadline_GivesNothingToRemindAbout()
    {
        // Срок оплаты Auction считается от продажи, а счёт выставляется позже
        // продажи: при коротком сроке напоминание оказалось бы позже срока, и
        // оно было бы шумом.
        var dueAt = IssuedAt.AddHours(6);

        InvoiceReminderMoments.For(InvoiceReminderKind.AfterWin, IssuedAt, dueAt, FirstLead, DueLead, MinGap)
            .ShouldBeNull();
        InvoiceReminderMoments.For(InvoiceReminderKind.BeforeDue, IssuedAt, dueAt, FirstLead, DueLead, MinGap)
            .ShouldBeNull();
    }

    [Fact]
    public void For_ShortPaymentTerm_GivesSecondMomentBeforeTheDeadline()
    {
        var dueAt = IssuedAt.AddDays(1);

        var second = InvoiceReminderMoments.For(InvoiceReminderKind.BeforeDue, IssuedAt, dueAt, FirstLead, DueLead,
            MinGap);

        second.ShouldNotBeNull();
        second!.Value.ShouldBeLessThan(dueAt);
    }
}
