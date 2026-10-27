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
    private static readonly TimeSpan IssueGap = TimeSpan.FromHours(1);

    private static readonly DateTimeOffset IssuedAt = new(2026, 10, 20, 12, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset? For(InvoiceReminderKind kind, DateTimeOffset dueAt) =>
        InvoiceReminderMoments.For(kind, IssuedAt, dueAt, IssueGap);

    [Fact]
    public void For_PaymentDueInSevenDays_GivesAllThreeMoments()
    {
        var dueAt = IssuedAt.AddDays(7);

        For(InvoiceReminderKind.DayBefore, dueAt).ShouldBe(dueAt.AddHours(-24));
        For(InvoiceReminderKind.HalfDayBefore, dueAt).ShouldBe(dueAt.AddHours(-12));
        For(InvoiceReminderKind.HourBefore, dueAt).ShouldBe(dueAt.AddHours(-1));
    }

    [Fact]
    public void For_PaymentDueInADay_SkipsTheMomentOfThePurchase()
    {
        // Срок в сутки: «за 24 часа» приходится на выставление счёта — рядом с
        // вестью о покупке, — и момент пропускается.
        var dueAt = IssuedAt.AddDays(1);

        For(InvoiceReminderKind.DayBefore, dueAt).ShouldBeNull();
        For(InvoiceReminderKind.HalfDayBefore, dueAt).ShouldBe(dueAt.AddHours(-12));
        For(InvoiceReminderKind.HourBefore, dueAt).ShouldBe(dueAt.AddHours(-1));
    }

    [Fact]
    public void For_MomentBeforeTheIssue_GivesNothing()
    {
        // Срок оплаты Auction считает от продажи, а счёт выставлен позже неё:
        // момент «за 24 часа» оказался раньше выставления.
        var dueAt = IssuedAt.AddHours(23);

        For(InvoiceReminderKind.DayBefore, dueAt).ShouldBeNull();
    }

    [Fact]
    public void For_MomentWithinTheGapAfterTheIssue_GivesNothing()
    {
        // Момент через полчаса после выставления — та же минута, что весть о
        // покупке: дубль в пределах допуска.
        var dueAt = IssuedAt.AddHours(24.5);

        For(InvoiceReminderKind.DayBefore, dueAt).ShouldBeNull();
    }

    [Fact]
    public void For_MomentJustPastTheGap_GivesTheMoment()
    {
        var dueAt = IssuedAt.AddHours(25).AddMinutes(1);

        For(InvoiceReminderKind.DayBefore, dueAt).ShouldBe(IssuedAt.AddHours(1).AddMinutes(1));
    }

    [Fact]
    public void Kinds_Scheduled_AreTheThreeDueLeads()
    {
        InvoiceReminderKinds.Scheduled.Select(InvoiceReminderKinds.Lead).ShouldBe(
            [TimeSpan.FromHours(24), TimeSpan.FromHours(12), TimeSpan.FromHours(1)]);
    }

    [Theory]
    [InlineData("after_win")]
    [InlineData("before_due")]
    [InlineData("before_24h")]
    [InlineData("before_12h")]
    [InlineData("before_1h")]
    public void Kinds_TextOfParsed_RoundTrips(string text)
    {
        // Старые виды разбираются: строка прежнего образа в окне выката
        // срабатывает, а не роняет проход.
        InvoiceReminderKinds.Text(InvoiceReminderKinds.Parse(text)).ShouldBe(text);
    }
}
