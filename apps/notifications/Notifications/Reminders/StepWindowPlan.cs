using Auction.V1;
using Notifications.Auction;
// Своя запись, а не одноимённое сообщение auction_service.proto (PER-778).
using LotStepWindow = Notifications.Auction.LotStepWindow;

namespace Notifications.Reminders;

/// <summary>Лот окна в сообщении о его начале: свой шаг и свой конец.</summary>
public sealed record StepWindowNoticeLot(Guid LotId, DateTimeOffset Until, Money Step);

/// <summary>
/// Чистое ядро задания начала окна сниженного шага: когда оно срабатывает и
/// какие окна ещё есть о чём объявлять. Ни базы, ни Orleans, ни часов.
/// </summary>
/// <remarks>
/// Момент срабатывания — не просто начало окна. Факты лотов одного запуска
/// приходят по одному, и сообщение, собранное на первом, назвало бы не все
/// лоты, которые человек отметил (ADR-047, дополнение 2026-10-12). Поэтому
/// задание ждёт не раньше выдержки после первого факта, а окно из будущего
/// ждёт своего начала: выдержка к нему уже прошла.
/// </remarks>
public static class StepWindowPlan
{
    /// <summary>
    /// Момент срабатывания задания: начало окна или выдержка после первого
    /// факта — что позже. Оба момента приводятся к точности хранения: они
    /// сравниваются и с записанным в базу.
    /// </summary>
    public static DateTimeOffset DueAt(DateTimeOffset startsAt, DateTimeOffset now, TimeSpan hold)
    {
        var held = ReminderPlan.ToStoredPrecision(now + hold);
        var start = ReminderPlan.ToStoredPrecision(startsAt);
        return start > held ? start : held;
    }

    /// <summary>
    /// Окно ещё идёт: объявлять о нём есть о чём. Окно, кончившееся до
    /// срабатывания, сообщения не даёт — человеку нечего с ним делать.
    /// </summary>
    public static bool Running(LotStepWindow window, DateTimeOffset now) => window.Until > now;
}
