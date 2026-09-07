/// Заглушечные ответы контракта. Доменное ядро уже есть, но транспорт с ним ещё не
/// связан: модуль уходит вместе с gRPC-слоем команд, по мере того как срезы
/// закрывают операции.
module Meetups.Transport.Placeholder

open Meetups.V1

/// Снимок заполняется только тем, что заглушка честно знает: пришедшим id.
/// Правдоподобные lifecycle и version были бы враньём, которое читатель через
/// месяц примет за поведение сервиса, а UNSPECIFIED и 0 читаются как
/// "решения ещё никто не принимал". Расписание — форма no_date, потому что
/// пустой oneof контракт вторым написанием "даты нет" не читает.
let snapshot (id: string) : MeetupSnapshot = MeetupSnapshot(Id = id, Schedule = Schedule(NoDate = NoDate()))

let visibleMeetups () : ListVisibleMeetupsResponse = ListVisibleMeetupsResponse()
