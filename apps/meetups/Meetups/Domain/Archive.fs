namespace Meetups.Domain

open System

/// Архив — производное правило чтения, а не четвёртое значение жизненного цикла
/// (PER-229). Живёт в ядре рядом с Access.fs и по той же причине: правило
/// принимается из значений и без I/O, поэтому чистая функция проверяется тестом
/// без базы, а единственное чтение сходок применяет её равносильно для обоих
/// продуктовых списков.
module Archive =

    /// Последняя названная расписанием календарная дата: по ней сходка «прошедшая».
    /// `NoDate` и `Tentative` не дают прошедшей намеренно: отсутствие даты ничего не
    /// утверждает, а «дата обсуждается» ещё не согласована, и живая сходка не должна
    /// тихо исчезать из актуальных. `Interval` решает датой конца — идущая сегодня
    /// сходка остаётся актуальной до своего последнего дня.
    let private lastNamedDate (schedule: Schedule) : DateOnly option =
        match schedule with
        | NoDate
        | Tentative _ -> None
        | Fixed value ->
            match value with
            | Day date -> Some date
            | DayStart moment -> Some moment.Date
            | Interval interval -> Some((LocalInterval.finish interval).Date)

    /// Сходка прошедшая, если последняя названная дата строго раньше сегодняшней:
    /// в день сходки она ещё актуальна, и время из расписания не выдумывается
    /// (ADR-022). «Сегодня» приходит значением — календарный день сообщества
    /// считает оболочка по настроенному часовому поясу, домен часов не читает.
    let hasPassed (today: DateOnly) (schedule: Schedule) : bool =
        match lastNamedDate schedule with
        | Some date -> date < today
        | None -> false

    /// Архив: обе конечные стадии жизненного цикла и планируемая прошедшая.
    /// Отменённая и состоявшаяся уходят туда сразу, прошедшая — без отдельной
    /// команды, по расписанию.
    let isArchived (today: DateOnly) (snapshot: MeetupSnapshot) : bool =
        match snapshot.Lifecycle with
        | Held
        | Cancelled -> true
        | Planned -> hasPassed today snapshot.Schedule

    /// Ключ «новейшая первой» для архива. `Schedule.order` метит `Interval` датой
    /// начала — уместно для актуального списка, где сходка ждёт своего начала, но
    /// не для архива: долгая сходка обогнала бы недавно закончившуюся короткую.
    /// Архивной её делает дата конца (`lastNamedDate`), так что тем же концом её и
    /// сортируют. `Undated`/`Tentative` не заводят собственного порядка внутри
    /// архива — как и в актуальном списке (ADR-022).
    let sortOrder (schedule: Schedule) : ScheduleOrder =
        match lastNamedDate schedule with
        | Some date -> ScheduleOrder.Dated(date, None)
        | None -> Schedule.order schedule
