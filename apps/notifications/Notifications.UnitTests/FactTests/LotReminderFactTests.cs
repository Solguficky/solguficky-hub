using Notifications.Facts;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Форма адресного факта напоминания о лоте. Идентификатор, момент и срок
/// годности приходят снаружи, поэтому сообщение проверяется без базы и часов.
/// </summary>
public class LotReminderFactTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 25, 10, 15, 30, TimeSpan.Zero);

    [Fact]
    public void LotReminder_CarriesTaskCauseAndLotIdWithoutRequestId()
    {
        var notificationId = Guid.CreateVersion7();
        var recipientId = Guid.CreateVersion7();
        var taskId = Guid.CreateVersion7();
        var lotId = Guid.CreateVersion7();
        var deadline = Now.AddHours(1);

        var fact = NotificationFacts.LotReminder(notificationId, recipientId, taskId, lotId, Now, deadline);

        fact.NotificationId.ShouldBe(notificationId.ToString());
        fact.RecipientId.ShouldBe(recipientId.ToString());
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotReminder);
        // Повод — сработавшее задание; ключ повода строки notification тот же.
        fact.Cause.ReminderTaskId.ShouldBe(taskId.ToString());
        fact.LotReminder.LotId.ShouldBe(lotId.ToString());
        // Срок годности — дедлайн лота: напоминание, не ушедшее до него, уже шум.
        fact.NotAfter.ShouldBe(NotificationFacts.Instant(deadline));
        fact.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void LotDeadlineClose_CarriesTaskCauseAndLotIdWithoutRequestId()
    {
        // Второй момент напоминания (ADR-063, дополнение 2026-10-20) — тип
        // свой: два момента не должны совпасть на одном ключе повода.
        var notificationId = Guid.CreateVersion7();
        var recipientId = Guid.CreateVersion7();
        var taskId = Guid.CreateVersion7();
        var lotId = Guid.CreateVersion7();
        var deadline = Now.AddMinutes(15);

        var fact = NotificationFacts.LotDeadlineClose(notificationId, recipientId, taskId, lotId, Now, deadline);

        fact.NotificationId.ShouldBe(notificationId.ToString());
        fact.RecipientId.ShouldBe(recipientId.ToString());
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotDeadlineClose);
        fact.Cause.ReminderTaskId.ShouldBe(taskId.ToString());
        fact.LotDeadlineClose.LotId.ShouldBe(lotId.ToString());
        fact.NotAfter.ShouldBe(NotificationFacts.Instant(deadline));
        fact.HasRequestId.ShouldBeFalse();
    }
}
