# Pekko Projection: чтение журнала по тегу в read model с сохранённым offset

Разбор объясняет, как `apps/auction` строит read model лота из журнала событий: как Pekko Persistence JDBC отдаёт события «всех лотов» потоком, что такое offset и почему он пишется той же транзакцией, что и read model, откуда в этом потоке берутся дыры и почему обработчик на дыре не падает, а дочитывает журнал. Читателю не нужно знать Pekko. Достаточно представлять Event Sourcing (агрегат — поток событий, состояние — их свёртка) и проекции в духе Marten: фоновый процесс, который читает события и пишет таблицы для чтения.

Как entity лота пишет события — в [pekko-persistence-typed.md](pekko-persistence-typed.md). Почему теги именно такие — в [ADR-061](../../decisions/ADR-061-auction-journal-tag-slices.md).

Опора:
- срез PER-324: `apps/auction/src/main/scala/auction/projection/` (`LotProjection.scala`, `LotView.scala`, `LotViewHandler.scala`, `PooledJdbcSession.scala`), `entity/LotTags.scala`, `application.conf`, миграция `V5__lot_projection.sql`;
- исходники `pekko-persistence-jdbc_3-1.3.0-sources.jar` (`query/JournalSequenceActor.scala`, `query/scaladsl/JdbcReadJournal.scala`), `pekko-projection-jdbc_3-1.1.0-sources.jar` (`internal/JdbcProjectionImpl.scala`, `internal/JdbcSessionUtil.scala`), `pekko-persistence_3-1.6.0-sources.jar` (`Persistence.scala`);
- прогоны той же сессии: L1-сьют `LotProjectionIntegrationSpec` на PostgreSQL и падение `shutdownTestKit` до правки `PostgresFixture`.

## Механика

### Read journal: поток событий не одного агрегата, а многих

Entity лота пишет события в таблицу `event_journal`, и каждая строка принадлежит одному `persistence_id` (`lot|<lot_id>`). Чтобы собрать read model «все лоты аукциона», нужен поток событий всех лотов сразу. Его отдаёт **read journal** — читающая сторона плагина журнала. У Pekko Persistence JDBC она умеет три вида запросов: `eventsByPersistenceId` (один агрегат), `persistenceIds` (список агрегатов) и `eventsByTag` (все события с данной меткой). Глобального «дай всё по порядку» без тега у этого плагина нет: запросы по срезам (`eventsBySlices`) есть только у других плагинов.

**Тег** — строка, которую entity приписывает событию в момент записи. Плагин кладёт её в отдельную таблицу `event_tag (event_id, tag)`, где `event_id` ссылается на `ordering` — глобальный автоинкрементный номер строки журнала:

```sql
CREATE TABLE event_journal (
  ordering BIGSERIAL,
  persistence_id VARCHAR(255) NOT NULL,
  sequence_number BIGINT NOT NULL,
  ...
```

Тег ставится при append и потом не меняется: событие, записанное без тега, `eventsByTag` не увидит никогда. Поэтому схема тегов — часть формата журнала, как имена полей JSON, и выбирается до первого боевого события (ADR-045, ADR-061).

### Offset — закладка читателя

`eventsByTag(tag, offset)` отдаёт события тега с `ordering` больше `offset`. **Offset** здесь — это `ordering` последнего обработанного события. Проекция сохраняет его в таблицу `pekko_projection_offset_store` строкой с ключом «имя проекции + ключ проекции», а после рестарта читает и продолжает со следующего события. Так рестарт не переигрывает историю — это и есть ПП-3 и кейс Т-06а.

Аналог в .NET — позиция подписки в EventStoreDB или `HighWaterMark` у Marten Async Daemon. Отличие: здесь offset — номер в общем для всех тегов счётчике `ordering`, а не номер внутри потока тега. Между двумя событиями одного тега может лежать сколько угодно событий других тегов.

### `exactlyOnce`: offset и read model одной транзакцией

Обработчик проекции — это `JdbcHandler`: функция «сессия + событие → запись в базу». Режим `JdbcProjection.exactlyOnce` оборачивает каждое событие так (`JdbcProjectionImpl.adaptedHandlerForExactlyOnce`):

```scala
JdbcSessionUtil
  .withSession(sessionFactory) { sess =>
    sess.withConnection[Unit] { conn =>
      offsetStore.saveOffsetBlocking(conn, projectionId, offset)
    }
    // run users handler
    delegate.process(sess, envelope)
  }
```

`withSession` открывает новую сессию на каждое событие, вызывает функцию и делает `commit`, а на исключении — `rollback` (`JdbcSessionUtil.scala`). Offset и строки read model пишутся одним соединением в одной транзакции: либо закоммичено и то и другое, либо ничего. Read model не может оказаться впереди offset, и наоборот.

Из этого вытекает правило для кода обработчика: писать можно только через соединение сессии. В `LotViewHandler` все запросы идут через `session.withConnection { connection => ... }`. Если бы обработчик записал строку через пул Slick, эта запись закоммитилась бы своей транзакцией. Тогда при откате события read model ушла бы вперёд offset, и следующая доставка того же события применила бы его второй раз.

Сессию проект пишет сам (`PooledJdbcSession`): она берёт соединение из пула плагина журнала, выключает `autoCommit`, а `close` возвращает соединение в пул. Поток, который исполняет обработчики, — отдельный диспетчер `pekko.projection.jdbc.blocking-jdbc-dispatcher`. Его размер в `application.conf` — 4, меньше пула журнала, чтобы проекция не заняла все соединения.

### Повторная доставка и версия строки

«Exactly once» обещает, что offset и эффект обработчика согласованы. Но одно и то же событие обработчик может увидеть повторно: после отката, после рестарта со старым offset. Поэтому строка `lot_view` хранит `version` — номер последнего применённого события лота (`sequence_number` в журнале), и чистое ядро решает по нему:

```scala
val version = current.fold(0L)(_.version)
if (sequence <= version) Right(LotViewStep.Skip)
else if (sequence != version + 1) Left(LotViewDefect.Gap(lotId, version, sequence))
```

Повтор пропускается, следующий номер применяется, а пропуск номера — особый случай, о нём ниже. Тест Т-06а держит отрицательный контроль: удаляет строки offset, поднимает узел заново и видит, что обработчик вызван на все шесть событий, а хронология ставок `lot_bid` не задвоилась.

### Дыры в потоке тега

`ordering` — `BIGSERIAL`, номер выдаётся при вставке, до коммита. Две транзакции журнала могут закоммититься в обратном порядке: номер 11 виден, а номер 10 ещё нет. Если читатель отдаст 11 и сдвинет offset, то 10 он не прочитает уже никогда. Поэтому `eventsByTag` не читает выше границы, которую держит `JournalSequenceActor`: актор опрашивает номера журнала и двигает границу только через непрерывный ряд.

Ждать бесконечно он не может: номер мог и не закоммититься никогда (откаченная транзакция). Код решает так:

```scala
if ((currentMax + 1).until(currentElement).forall(givenUp.contains)) {
  // 1) they have been detected as missing on previous iteration, it's time now to give up
```

Пропущенный номер запоминается и признаётся «дырой навсегда» через `max-tries` опросов с интервалом `query-delay`. В сервисе это 50 × 200 мс, около десяти секунд (`application.conf`, блок `jdbc-read-journal.journal-sequence-retrieval`). На старте актор вдобавок считает пропущенным всё ниже текущего максимума через то же окно (`ScheduleAssumeMaxOrderingId`). Транзакция журнала, закоммиченная позже окна, оставляет событие в журнале, но не в потоке тега.

### Дыра не должна останавливать тег

Если поток тега не принёс событие лота с номером 5, следующее событие этого лота придёт с номером 6. Ядро вернёт `Gap`. Обработчик, который на `Gap` бросает исключение, откатит транзакцию, проекция перезапустится с того же offset, получит то же событие 6 и снова упадёт. Встанет не один лот, а весь тег — четверть всех лотов. Ровно этот дефект нашло ревью корректности.

Тот же путь дают и другие источники пропуска: события, записанные до появления тегов, и смена числа тегов, при которой лот переезжает в другой тег. Поэтому обработчик на `Gap` дочитывает недостающие события **из журнала лота**, а не из потока тега, тем же соединением сессии:

```scala
case Left(LotViewDefect.Gap(_, version, sequence)) =>
  missing(connection, envelope.persistenceId, version, sequence) :+ delivered
```

`missing` выбирает строки `event_journal` этого `persistence_id` с номерами между версией и доставленным событием и десериализует их тем же сериализатором, что и entity. Дальше `LotView.fold` сворачивает их вместе с доставленным. Дефектом пропуск остаётся, только если и журнал этих строк не держит. L1-тест «reads the events its tag stream does not carry» удаляет теги первых двух событий лота и проверяет, что read model всё равно совпала с entity.

### Экземпляр на тег: `ShardedDaemonProcess`

Тегов четыре (`lot-0..lot-3`), и у каждого свой offset. Проекция запускается четырьмя экземплярами, по одному на тег, через `ShardedDaemonProcess`: Pekko держит N акторов с номерами `0..N-1` живыми где-то в кластере и перезапускает упавший. Номер экземпляра выбирает тег:

```scala
ShardedDaemonProcess(system).init[ProjectionBehavior.Command](
  Name,
  LotTags.Count,
  index => ProjectionBehavior(projection(system, LotTags.all(index), metrics, handler)),
```

Тег лота считает Pekko: `Persistence.sliceForPersistenceId` — это `math.abs(persistenceId.hashCode % numberOfSlices)` при `numberOfSlices = 1024`. Тег — остаток от деления на 4. Все события одного лота попадают в один тег, поэтому их порядок внутри тега совпадает с порядком в журнале лота.

Побочный эффект в тестах: экземпляры размещает координатор шардинга, и пока узел только поднимается, они ждут его. Если гасить узел в этот момент, фаза `cluster-sharding-shutdown-region` ждёт их весь свой таймаут в 10 секунд — ровно предел `shutdownTestKit`. Остановка падала с `Failed to stop [...] within [10 seconds]`, в дереве акторов висел `projection-lot-view`. В тестовой конфигурации узла таймаут фазы сокращён до 2 секунд, после этого сьют зелёный.

### Вторая проекция того же журнала и сеть вне транзакции

Публикация фактов в шину (PER-331) — вторая проекция того же журнала лотов. От первой она отличается одним: именем, `ProjectionId("lot-publication", tag)` вместо `("lot-view", tag)`. Имя — ключ строки в `pekko_projection_offset_store`, поэтому у каждой проекции своя закладка, и отставание одной не двигает и не держит другую. Аналог из .NET — две независимые подписки на один поток событий, каждая со своим checkpoint.

Обработчику публикации нужен снимок лота **ровно после** своего события. Взять его из `lot_view` нельзя: эту строку двигает другая проекция, и в момент обработки она может быть и впереди, и позади. Поэтому у публикации своя строка свёрнутого лота `lot_publication` той же формы, а свёртку делают общие `LotRows` и `LotView.replay` — та же `Lot.apply`, что у entity.

Главное в этом срезе — куда **не** класть сетевой вызов. Соблазн такой: в обработчике `exactlyOnce` опубликовать в NATS, дождаться ack и только потом дать транзакции закоммититься. Повтор тогда детерминирован: offset и строка откатываются вместе, снимок пересчитывается тот же. Но транзакция `JdbcSession` держит соединение, а сессия берёт его из пула журнала (`PooledJdbcSession.scala`):

```scala
 * Пул общий с журналом, поэтому `pekko.projection.jdbc.blocking-jdbc-dispatcher` меньше пула: проекция не может занять
 * все соединения и оставить журнал без записи.
```

Обработчик к тому же исполняется на `blocking-jdbc-dispatcher` — одном пуле потоков на **все** JDBC-проекции узла (`fixed-pool-size = 8`, по потоку на экземпляр). Ожидание ack внутри транзакции при лежащей шине держало бы и поток, и соединение на весь таймаут, на каждой попытке после рестарта проекции, и делило бы потоки с экземплярами read model.

Поэтому транзакция проекции пишет в базу и только в базу: свою строку лота, строку `lot_outbox` с готовым Protobuf и offset. В сеть ходит отдельный релей на таймере (`OutboxRelay`): берёт строки в порядке `position`, публикует, ждёт ack и удаляет строку. Это тот же outbox, что у Identity, только место «изменения состояния» занимает проекция журнала. L1-тест «keep accepting bids while the bus is down and deliver the facts once it is back» ставит контейнер NATS на паузу: ставки принимаются, outbox растёт, после снятия паузы факты доходят по порядку.

## Урок

- Offset читателя и эффект обработчика должны коммититься вместе, иначе после отката одно из двух опережает другое. Это переносится на любой стек: outbox в Identity — та же идея с другой стороны, «изменение состояния и событие одной транзакцией».
- Глобальный номер журнала, который выдаётся до коммита, не годится как надёжная закладка без ожидания дыр, а ожидание конечно. Любой читатель такого потока должен уметь пережить событие, которое прошло мимо: дочитать его по другому ключу или сознательно его потерять.
- Обработчик, который на «невозможном» событии падает, превращает один дефект данных в остановку всего потока. Падение уместно, только если у дефекта нет обхода.
- Повторная доставка — нормальный режим, а не авария. Идемпотентность держит версия строки, а не надежда на «ровно один раз».
- Транзакция, которая делит пул соединений и потоков с соседями, не должна ждать сеть: отказ внешней системы превращается в отказ соседей. Сеть выносится за транзакцию через outbox, и отказ остаётся очередью, а не остановкой.

## Почему так, а не иначе

- **Писать read model отдельным пулом или из entity.** Проще в коде, но запись read model и offset разъезжаются: после отката события read model уже содержит его, а offset нет. Повтор применит событие второй раз.
- **Читать read model из entity («спросить актора»).** Чтение без отставания, но каждое чтение будит entity в шарде. Список лотов аукциона пришлось бы собирать опросом каждого лота. Владелец принял отставание чтения от записи (матрица решений, PER-324).
- **Падать на пропуске номера.** Так было в плане: громко и просто. Цена — один пропуск в потоке тега навсегда останавливает тег. Отвергнуто после ревью.
- **Увеличить окно ожидания дыр.** Окно в десять секунд уже длиннее предела соединения и запроса. Большее окно задерживает весь тег на каждой откаченной транзакции и всё равно конечно. Дочитка журнала закрывает и пропуск после окна, и события без тега.
- **Один тег на все лоты.** Одна строка offset и одна проекция. Цена — один поток навсегда для каждой будущей проекции, а распараллелить позже можно только переписыванием `event_tag` (ADR-061).
- **`pekko-projection-slick` вместо JDBC-сессии.** Тот же пул Slick без своей сессии. ADR-045 называет именно `JdbcProjection.exactlyOnce`; своя сессия — двадцать строк.

- **Публиковать прямо из обработчика `exactlyOnce`, ack до коммита.** Меньше всего кода и детерминированный повтор. Цена — открытая транзакция и занятый поток общего диспетчера на всё время ожидания ack, а лежащая шина задевает и read model. Отвергнуто в PER-331.
- **`atLeastOnce` с публикацией до записи состояния, без outbox.** Транзакция короткая, outbox не нужен. Цена — повтор после записи состояния, но до offset, уже нельзя пересчитать: снимок ушёл вперёд, и корректность держит ручной пропуск по версии. Отставание «записано, но не в шине» тоже не отличить от отставания проекции.

## Схема

```mermaid
sequenceDiagram
    participant E as entity лота
    participant J as event_journal + event_tag
    participant S as JournalSequenceActor
    participant P as экземпляр проекции (тег lot-1)
    participant DB as lot_view, lot_bid, offset

    E->>J: append события, tag = lot-(slice % 4)
    S->>J: опрос ordering, граница без дыр
    P->>J: eventsByTag(lot-1, offset) до границы
    J-->>P: событие (seq лота, ordering)
    P->>DB: BEGIN; save offset
    alt seq = version + 1
        P->>DB: upsert lot_view, insert lot_bid
    else seq ≤ version
        P->>DB: ничего (повтор)
    else seq > version + 1
        P->>J: дочитать события лота version+1..seq-1
        P->>DB: свернуть и записать
    end
    P->>DB: COMMIT (или ROLLBACK на исключении)
```

## Первоисточники

- [Pekko Projection — JDBC](https://pekko.apache.org/docs/pekko-projection/current/jdbc.html) — режимы `exactlyOnce` и `atLeastOnce`, `JdbcSession`, схема таблиц offset.
- [Pekko Projection — Events from Pekko Persistence](https://pekko.apache.org/docs/pekko-projection/current/eventsourced.html) — `EventSourcedProvider.eventsByTag` и как он связан с тегами.
- [Pekko Projection — Running a Projection](https://pekko.apache.org/docs/pekko-projection/current/running.html) — `ShardedDaemonProcess` и `ProjectionBehavior`.
- [Pekko Persistence JDBC — Query](https://pekko.apache.org/docs/pekko-persistence-jdbc/current/query.html) — какие запросы умеет read journal этого плагина.
- `pekko-persistence-jdbc_3-1.3.0-sources.jar`, `query/JournalSequenceActor.scala` — алгоритм поиска дыр и момент, когда номер считается пропущенным навсегда.
- `pekko-projection-jdbc_3-1.1.0-sources.jar`, `internal/JdbcProjectionImpl.scala` и `JdbcSessionUtil.scala` — где сохраняется offset и где commit и rollback.
- [ADR-045](../../decisions/ADR-045-auction-scala-pekko-persistence-jdbc.md) и [ADR-061](../../decisions/ADR-061-auction-journal-tag-slices.md) — почему проекция и почему такие теги.

## Проверь себя

1. Что увидит проекция, если удалить строку offset её тега и перезапустить узел? *Ответ: обработчик получит все события тега заново, но read model не изменится — повтор пропускается по версии. Проверка: тест «continues after a restart» в `LotProjectionIntegrationSpec`, счётчик вызовов после удаления offset равен 6.*
2. В каком порядке `exactlyOnce` пишет offset и вызывает обработчик? *Ответ: сначала offset, потом обработчик, в одной сессии; commit после обоих. Проверка: `grep -n "saveOffsetBlocking" -A4` по `JdbcProjectionImpl.scala` из source-jar.*
3. Сколько ждёт `eventsByTag` незакоммиченный номер `ordering` в этом сервисе? *Ответ: `max-tries × query-delay` = 50 × 200 мс. Проверка: блок `jdbc-read-journal.journal-sequence-retrieval` в `apps/auction/src/main/resources/application.conf`.*
4. В какой тег попадёт лот `01926f3c-8b7a-7cde-8f00-000000000001`? *Ответ: `lot-1`. Проверка: тест «tags every event of a lot» в `LotProjectionIntegrationSpec` читает `event_tag` после записи.*
5. Почему остановленная проекция публикации не задерживает `GetLot`? *Ответ: у неё своё имя, а значит своя строка offset и своя строка лота; read model её не ждёт. Проверка: `SELECT projection_name, projection_key FROM pekko_projection_offset_store` в базе узла после старта — по четыре строки на `lot-view` и `lot-publication`.*
6. Что будет, если обработчик проекции запишет строку через `SlickLotViews` вместо соединения сессии и упадёт после записи? *Ответ: строка останется, offset откатится, и повтор применит событие ко уже продвинутой строке — условие версии в `UPDATE` не пропустит запись, обработчик упадёт. Проверь сам мутацией: замени соединение сессии на пул в `LotViewHandler.write` и прогони тест «never leaves the read model ahead of the offset».*
