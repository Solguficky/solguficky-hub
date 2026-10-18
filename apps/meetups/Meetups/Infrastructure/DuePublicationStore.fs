/// Набор сходок, у которых назначенный момент публикации наступил.
///
/// Отдельный модуль, а не вход в `MeetupReading`: тот объявлен единственным
/// продуктовым путём чтения со смотрящим, и второй безсмотрящий вход размывал бы это
/// обещание. Сценарий здесь начинают часы, правил человеческой видимости у него нет,
/// и читает он состояние для принятия решения — то же, что делает командный
/// `MeetupStore.load`, только пачкой.
module Meetups.Infrastructure.DuePublicationStore

open System
open System.Threading.Tasks
open Dapper
open Meetups.Domain
open Npgsql

/// Размер набора и самый ранний наступивший момент — то, чем отвечают на вопрос
/// «не растёт ли набор». Возраст считается снаружи, от того же мгновения, из
/// которого принято решение: два чтения часов дали бы одному тику два времени.
[<CLIMutable>]
type DueBacklogRow =
    {
        Due: int64
        OldestDueAt: Nullable<DateTimeOffset>
    }

do Db.ensureTypeHandlers ()

/// Первые два конъюнкта дословно повторяют предикат частичного индекса
/// `meetups_due_publication` (001_meetups_schema.sql), поэтому его применимость
/// планировщику видна текстуально, а не выводится из строгости оператора. Третий —
/// диапазон по самому ключу индекса.
///
/// `lifecycle <> 'cancelled'` здесь намеренно нет. Отменённая сходка в набор попасть
/// не может: применение `MeetupCancelled` обнуляет момент, а
/// `meetups_scheduled_publish_not_cancelled` делает обратную строку невыразимой.
/// Лишний предикат заставил бы перепроверять кучу и увёл бы запрос с индекса.
[<Literal>]
let private DuePredicateSql =
    """
    WHERE scheduled_publish_at IS NOT NULL
      AND visibility = 'hidden'
      AND scheduled_publish_at <= @now
    """

/// Третья копия списка колонок после `MeetupStore.SelectSql` и
/// `MeetupReading.selectAllSql`. Общий фрагмент не выделяется: он приватен у обоих
/// соседей намеренно — склейка из чужого модуля однажды уже дала бы `WHERE ... WHERE`
/// молча, и `MeetupReading` объясняет это прямо. Согласованность списка с `MeetupRow`
/// держит отображение Dapper по алиасам, то есть падение теста, а не тихий null.
[<Literal>]
let private SelectDueSql =
    """
    SELECT
        id AS Id,
        author AS Author,
        title AS Title,
        description AS Description,
        venue AS Venue,
        kind AS Kind,
        calendar_link AS CalendarLink,
        materials AS Materials,
        lifecycle AS Lifecycle,
        visibility AS Visibility,
        first_published_at AS FirstPublishedAt,
        scheduled_publish_at AS ScheduledPublishAt,
        version AS Version,
        schedule_form AS ScheduleForm,
        schedule_precision AS SchedulePrecision,
        schedule_start_date AS ScheduleStartDate,
        schedule_start_time AS ScheduleStartTime,
        schedule_end_date AS ScheduleEndDate,
        schedule_end_time AS ScheduleEndTime
    FROM meetups
    """

/// `ORDER BY scheduled_publish_at` совпадает с порядком ключа индекса, поэтому
/// сортировки нет, а `LIMIT` останавливает обход. Порядок при этом не курсор:
/// следующий тик читает набор заново, и пропущенную пачкой сходку он увидит снова.
[<Literal>]
let private DuePageSql =
    """
    ORDER BY scheduled_publish_at
    LIMIT @limit
    """

[<Literal>]
let private BacklogSql =
    """
    SELECT
        COUNT(*) AS Due,
        MIN(scheduled_publish_at) AS OldestDueAt
    FROM meetups
    """

/// Размер набора и пачка читаются одной repeatable-read транзакцией и одним
/// значением часов — ровно по тем же причинам, что `DispatchStore.readQueue`.
/// Двумя отдельными чтениями команда, назначившая момент между ними, дала бы отчёт
/// «в наборе пусто, опубликована одна сходка»: числа описывали бы разные наборы,
/// хотя названы одним.
let readDue (source: NpgsqlDataSource) (now: DateTimeOffset) (limit: int) : Task<DueBacklogRow * MeetupSnapshot list> =
    task {
        use! connection = source.OpenConnectionAsync()
        use! transaction = connection.BeginTransactionAsync(System.Data.IsolationLevel.RepeatableRead)

        let parameters =
            {|
                now = now
                limit = limit
            |}

        let! backlog =
            connection.QuerySingleAsync<DueBacklogRow>(
                BacklogSql + DuePredicateSql,
                parameters,
                transaction = transaction
            )

        let! rows =
            connection.QueryAsync<MeetupRow.MeetupRow>(
                SelectDueSql + DuePredicateSql + DuePageSql,
                parameters,
                transaction = transaction
            )

        do! transaction.CommitAsync()

        return backlog, rows |> Seq.map MeetupRow.toSnapshot |> List.ofSeq
    }
