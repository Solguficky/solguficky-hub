namespace Meetups.Domain

/// Исход запрошенного перехода одной оси. Три значения, а не Result: «перешли» и
/// «уже там» — разные исходы, и слитые в Ok они вернули бы идемпотентность повтора
/// в дисциплину автора каждой команды. Команда, сформулированная как целевое
/// состояние, отвечает на AlreadyThere успехом без события (ADR-031, I5).
[<RequireQualifiedAccess>]
type TransitionOutcome =
    | Allowed
    | AlreadyThere
    | Rejected

/// Таблицы допустимых переходов обеих осей состояния сходки (ADR-022).
///
/// Модуль стоит в порядке компиляции до Domain/Meetup.fs по тому же правилу, что и
/// Domain/Access.fs: решение о допустимости перехода не должно быть способно
/// увидеть приватное представление агрегата. Отсюда же форма — функции берут
/// значения ОДНОЙ оси и потому физически не способны прочитать вторую.
/// Независимость осей перестаёт быть требованием к автору и становится свойством
/// типа: смена видимости не может двинуть жизненный цикл, потому что его не видит.
///
/// Межосевые предусловия сюда не входят и входить не могут. «Отменённую сходку
/// нельзя опубликовать» — условие команды поверх разрешённого перехода, того же
/// рода, что обязательный заголовок при публикации, а не переход сам по себе.
/// Решает его decidePublish, и там же оно останется, когда соседние листья заведут
/// свои команды.
module MeetupTransitions =

    /// Жизненный цикл: «запланирована → состоялась | отменена» (ADR-022). Обе
    /// конечные стадии терминальны: «отмену не возвращает никто», а состоявшаяся
    /// сходка не возвращается в план — прошедшее не перепланируется, оно уходит в
    /// архив (PER-229).
    ///
    /// Пары перечислены поимённо, без catch-all. Это и есть проверка полноты:
    /// четвёртое значение оси обязано уронить сборку здесь, а не тихо получить
    /// поведение соседней клетки.
    let lifecycle (current: MeetupLifecycle) (target: MeetupLifecycle) : TransitionOutcome =
        match current, target with
        | Planned, Planned -> TransitionOutcome.AlreadyThere
        | Planned, Held -> TransitionOutcome.Allowed
        | Planned, Cancelled -> TransitionOutcome.Allowed
        | Held, Held -> TransitionOutcome.AlreadyThere
        | Held, Planned -> TransitionOutcome.Rejected
        | Held, Cancelled -> TransitionOutcome.Rejected
        | Cancelled, Cancelled -> TransitionOutcome.AlreadyThere
        | Cancelled, Planned -> TransitionOutcome.Rejected
        | Cancelled, Held -> TransitionOutcome.Rejected

    /// Видимость обратима в обе стороны: ADR-022 сделал ось такой ради снятия с
    /// публикации и возврата. Отметку первой публикации таблица не касается —
    /// её однократность держит применение события, а не решение о переходе, и
    /// поэтому возврат из «скрыта» второй раз отметку не перепишет.
    let visibility (current: MeetupVisibility) (target: MeetupVisibility) : TransitionOutcome =
        match current, target with
        | Hidden, Hidden -> TransitionOutcome.AlreadyThere
        | Hidden, Visible -> TransitionOutcome.Allowed
        | Visible, Hidden -> TransitionOutcome.Allowed
        | Visible, Visible -> TransitionOutcome.AlreadyThere
