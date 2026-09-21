/// Журнал как очередь публикации: выборка неотправленного, отметка отправленного и
/// ход, который делает публикацию исключительной. Модуль знает только SQL и Npgsql.
///
/// Решения он не принимает намеренно. ADR-035 оставил порядок «сначала подтверждение
/// transport, потом отметка» ответственностью релея, а не схемы, поэтому «что
/// публиковать и когда отмечать» решает срез, а здесь лежат ровно те четыре
/// запроса, которыми он это делает.
module Meetups.Infrastructure.DispatchStore

open System
open System.Threading.Tasks
open Dapper
open Npgsql

// Типы дат Dapper узнаёт до первого запроса. Регистрация повторяется здесь по той
// же причине, что в MeetupStore и MeetupReading: зависимости собираются в
// нескольких местах, и пропуск в одном из них означал бы отказ в рантайме.
do Db.ensureTypeHandlers ()

/// Ключ хода публикации. Отличается от ключа миграций (`Migrations.fs`) намеренно:
/// один процесс держит оба одновременно на разных соединениях, и общий ключ
/// превратил бы старт сервиса в самоблокировку.
///
/// Область действия advisory-блокировки — база, а не кластер, поэтому число
/// достаточно развести внутри Meetups, а не по всему серверу PostgreSQL.
///
/// Ключ виден наружу ради теста изоляции: соперник обязан захватывать ровно тот
/// замок, что и продукт. Приватный ключ пришлось бы продублировать литералом в
/// тесте, и тогда смена ключа оставила бы тест зелёным на пустом месте.
[<Literal>]
let TurnKey = 872514054L

[<Literal>]
let private TakeTurnSql = "SELECT pg_try_advisory_lock(@key)"

[<Literal>]
let private ReleaseTurnSql = "SELECT pg_advisory_unlock(@key)"

/// Бэклог целиком, а не страница: размер и возраст описывают очередь, которую тик
/// застал, и считаются до публикации. `MIN(occurred_at)` — возраст самой ранней
/// неотправленной записи, то есть лаг публикации, а не возраст строки в таблице.
[<Literal>]
let private BacklogSql =
    """
    SELECT
        COUNT(*) AS Pending,
        MIN(occurred_at) AS OldestOccurredAt
    FROM meetup_events
    WHERE dispatched_at IS NULL
    """

/// Набор задан состоянием строки, а не позицией: `position` стоит только в
/// `ORDER BY`. High-water mark по нему запрещён ADR-035 — identity выдаётся при
/// INSERT, а строка становится видимой при COMMIT, поэтому запись с меньшим
/// номером может появиться позади уже сдвинутого курсора и не вернуться никогда.
///
/// Частичный индекс `meetup_events_pending_dispatch` покрывает ровно этот предикат
/// и этот порядок, поэтому выборка идёт по бэклогу, а не по истории.
[<Literal>]
let private PendingSql =
    """
    SELECT
        event_id AS EventId,
        meetup_id AS MeetupId,
        version AS Version,
        event_type AS EventType,
        payload::text AS Payload,
        performed_by AS PerformedBy,
        occurred_at AS OccurredAt
    FROM meetup_events
    WHERE dispatched_at IS NULL
    ORDER BY position
    LIMIT @limit
    """

/// Единственная правка журнала, которую допускает схема: триггер
/// `meetup_events_record_immutable` объявлен `BEFORE UPDATE OF` по каноническим
/// колонкам, и `dispatched_at` в их перечисление не входит. Любая другая колонка в
/// этом запросе означала бы отказ `MT001` на первом же тике.
///
/// Предикат `dispatched_at IS NULL` делает отметку идемпотентной: повтор даёт ноль
/// задетых строк, а не перезапись чужого момента.
[<Literal>]
let private MarkSql =
    """
    UPDATE meetup_events
    SET dispatched_at = @dispatched_at
    WHERE event_id = @event_id
      AND dispatched_at IS NULL
    """

/// Строка бэклога в терминах .NET: nullable вместо option, как в MeetupRow.
/// CLIMutable нужен Dapper для материализации.
[<CLIMutable>]
type BacklogRow =
    {
        Pending: int64
        OldestOccurredAt: Nullable<DateTimeOffset>
    }

[<CLIMutable>]
type PendingRow =
    {
        EventId: Guid
        MeetupId: Guid
        Version: int64
        EventType: string
        Payload: string
        PerformedBy: Guid
        OccurredAt: DateTimeOffset
    }

/// Ход отпускается явным `unlock`, а не только закрытием соединения. Закрытие
/// вернуло бы его в пул, и Npgsql снял бы захват сбросом сессии — но тогда
/// освобождение держалось бы на настройке пула, а не на этом коде.
let private releaseTurn (connection: NpgsqlConnection) : Task<unit> =
    task {
        try
            let! _ =
                connection.ExecuteScalarAsync<bool>(
                    ReleaseTurnSql,
                    {|
                        key = TurnKey
                    |}
                )

            ()
        finally
            connection.Dispose()
    }

/// Захват живёт на сессии, а не на транзакции, поэтому соединение держится до конца
/// тика и берётся отдельно от пула запросов. Соединение, вернувшееся в пул, ход
/// теряет — это и есть причина, по которой здесь нет `use`.
///
/// `try_`, а не ожидающий вариант: проигравший экземпляр обязан немедленно уйти на
/// следующий тик, а не копиться в очереди ожидания. Ожидание без предела на пути
/// фоновой работы — отказ, который нечем диагностировать.
let tryTakeTurn (source: NpgsqlDataSource) : Task<(unit -> Task<unit>) option> =
    task {
        let connection = source.CreateConnection()
        let mutable taken = false

        try
            do! connection.OpenAsync()

            let! acquired =
                connection.ExecuteScalarAsync<bool>(
                    TakeTurnSql,
                    {|
                        key = TurnKey
                    |}
                )

            taken <- acquired
        finally
            // Соединение переживает эту функцию только у победителя. Отказ захвата и
            // отказ самого соединения закрываются одинаково, поэтому ветки нет.
            if not taken then
                connection.Dispose()

        if taken then return Some(fun () -> releaseTurn connection) else return None
    }

/// Бэклог и пачка читаются одной repeatable-read транзакцией, как и страница в
/// `MeetupReading.readStates`. Двумя отдельными чтениями команда, закоммитившая
/// событие между ними, давала бы отчёт «в очереди пусто, опубликована одна запись»:
/// числа описывали бы разные очереди, хотя названы одной.
let readQueue (source: NpgsqlDataSource) (limit: int) : Task<BacklogRow * PendingRow list> =
    task {
        use! connection = source.OpenConnectionAsync()
        use! transaction = connection.BeginTransactionAsync(System.Data.IsolationLevel.RepeatableRead)

        let! backlog = connection.QuerySingleAsync<BacklogRow>(BacklogSql, transaction = transaction)

        let! rows =
            connection.QueryAsync<PendingRow>(
                PendingSql,
                {|
                    limit = limit
                |},
                transaction
            )

        do! transaction.CommitAsync()

        return backlog, List.ofSeq rows
    }

/// Возвращает число задетых строк, а не `unit`: ноль означает, что строку успел
/// отметить кто-то другой, то есть событие уехало дважды. Это единственный повтор,
/// который релей способен наблюдать сам, и проглатывать его нельзя.
let markDispatched (source: NpgsqlDataSource) (eventId: Guid) (dispatchedAt: DateTimeOffset) : Task<int> =
    task {
        use! connection = source.OpenConnectionAsync()

        return!
            connection.ExecuteAsync(
                MarkSql,
                {|
                    event_id = eventId
                    dispatched_at = dispatchedAt
                |}
            )
    }
