using Notifications.Facts;
using Notifications.Reminders;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Форма адресного факта напоминания о счёте. Идентификатор, момент и срок
/// годности приходят снаружи, поэтому сообщение проверяется без базы и часов.
/// </summary>
public class InvoiceReminderFactTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 20, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void InvoiceReminder_CarriesTaskCauseAmountAndDeadline()
    {
        var notificationId = Guid.CreateVersion7();
        var recipientId = Guid.CreateVersion7();
        var taskId = Guid.CreateVersion7();
        var invoiceId = Guid.NewGuid();
        var lotId = Guid.CreateVersion7();
        var dueAt = Now.AddDays(7);

        var fact = NotificationFacts.InvoiceReminder(notificationId, recipientId, taskId, invoiceId, lotId,
            Amount(1500, "RUB"), dueAt, Now);

        fact.NotificationId.ShouldBe(notificationId.ToString());
        fact.RecipientId.ShouldBe(recipientId.ToString());
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.InvoiceReminder);
        // Повод — сработавшее задание; ключ повода строки notification тот же.
        fact.Cause.ReminderTaskId.ShouldBe(taskId.ToString());
        fact.InvoiceReminder.InvoiceId.ShouldBe(invoiceId.ToString());
        fact.InvoiceReminder.LotId.ShouldBe(lotId.ToString());
        fact.InvoiceReminder.Amount.MinorUnits.ShouldBe(1500);
        fact.InvoiceReminder.Amount.Currency.ShouldBe("RUB");
        // Срок годности — срок оплаты: напоминание, не ушедшее до него, уже шум.
        fact.NotAfter.ShouldBe(NotificationFacts.Instant(dueAt));
        fact.InvoiceReminder.PaymentDueAt.ShouldBe(NotificationFacts.Instant(dueAt));
        fact.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void InvoiceDueReminder_CarriesTheSameBodyUnderItsOwnType()
    {
        // Ближние моменты напоминания о счёте — за 12 часов и за час — несут
        // то же тело своим типом; ключ повода у каждого — своё задание.
        var notificationId = Guid.CreateVersion7();
        var recipientId = Guid.CreateVersion7();
        var taskId = Guid.CreateVersion7();
        var invoiceId = Guid.NewGuid();
        var lotId = Guid.CreateVersion7();
        var dueAt = Now.AddDays(7);

        var fact = NotificationFacts.InvoiceDueReminder(notificationId, recipientId, taskId, invoiceId, lotId,
            Amount(1500, "RUB"), dueAt, Now);

        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.InvoiceDueReminder);
        fact.Cause.ReminderTaskId.ShouldBe(taskId.ToString());
        fact.InvoiceDueReminder.InvoiceId.ShouldBe(invoiceId.ToString());
        fact.InvoiceDueReminder.LotId.ShouldBe(lotId.ToString());
        fact.InvoiceDueReminder.Amount.MinorUnits.ShouldBe(1500);
        fact.InvoiceDueReminder.Amount.Currency.ShouldBe("RUB");
        fact.NotAfter.ShouldBe(NotificationFacts.Instant(dueAt));
        fact.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void TypeOf_DueLeads_FarMomentIsReminderAndNearOnesAreDueReminders()
    {
        // Новых типов контракта PER-726 не заводит: дальний момент — тип
        // первого напоминания, ближние — тип напоминания о сроке.
        NotificationFacts.TypeOf(InvoiceReminderKind.DayBefore).ShouldBe(NotificationFacts.InvoiceReminderType);
        NotificationFacts.TypeOf(InvoiceReminderKind.HalfDayBefore).ShouldBe(NotificationFacts.InvoiceDueReminderType);
        NotificationFacts.TypeOf(InvoiceReminderKind.HourBefore).ShouldBe(NotificationFacts.InvoiceDueReminderType);
    }

    private static global::Auction.V1.Money Amount(long minorUnits, string currency) => new()
    {
        MinorUnits = minorUnits,
        Currency = currency,
    };
}
