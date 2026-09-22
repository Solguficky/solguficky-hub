/// Различение исходов после неуспешного сравнения версии (PER-78): сервис
/// перечитывает состояние только для того, чтобы отличить безопасный повтор от
/// настоящего конфликта. Автоматического повтора и слияния полей нет — устаревшее
/// намерение не применяется поверх чужой правки.
///
/// Общий модуль срезов, а не место внутри одного из них: вопрос задают все пять
/// команд изменения и переходов, и ответ у них один — совпадает ли текущее
/// состояние с целевым состоянием команды.
module Meetups.Slices.SafeRetry

open System.Threading.Tasks
open Meetups.Domain

/// Снимок, если команда уже достигла своей цели, и None, если расхождение версий
/// настоящее. Снимок возвращается успехом без события: записывать нечего, а
/// человеку показывают текущее состояние.
let discriminate
    (load: MeetupId -> Task<MeetupSnapshot option>)
    (event: MeetupEvent)
    (id: MeetupId)
    : Task<MeetupSnapshot option> =
    task {
        let! fresh = load id

        return
            match fresh with
            | Some snapshot when Meetup.targetReached event (Meetup.restore fresh) -> Some snapshot
            | _ -> None
    }
