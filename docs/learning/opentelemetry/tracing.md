# Трассировка OpenTelemetry: спан, контекст и ссылка через outbox

До PER-373 Identity отправлял по OTLP логи и метрики, но не трейсы, и цепочка вызова бота обрывалась на нём. Файл объясняет, что такое трейс и спан, как контекст трассировки переходит из процесса в процесс и почему спан публикации outbox ссылается на запрос, а не продолжает его. Объяснение идёт на коде `apps/identity`: `cmd/identity/telemetry.go`, `internal/server/tracing.go`, `internal/migrations/tracer.go`, `internal/outbox/trace.go`, `internal/relay/relay.go`, и на исходниках OpenTelemetry Go v1.44.0 и otelgrpc v0.69.0 из кеша модулей.

## Механика

### Трейс, спан и контекст

**Спан** — одна операция со временем начала и конца: обработка RPC, один SQL-запрос, одна публикация. **Трейс** — дерево спанов с общим `TraceID`. У каждого спана свой `SpanID` и ссылка на родителя. Аналог из .NET — `System.Diagnostics.Activity`: трейс — это `Activity.TraceId`, спан — сама `Activity`, `ActivitySource` — трейсер. Главное отличие Go: у него нет `Activity.Current`, то есть неявного «текущего» спана на поток. Текущий спан лежит в `context.Context`, и его несут явно, первым аргументом каждой функции.

Поэтому `Start` возвращает новый контекст, и дочерние операции получают именно его:

```go
ctx, span := t.tracer.Start(ctx, operation, trace.WithSpanKind(trace.SpanKindClient), ...)
```

Забыл передать новый `ctx` дальше — следующий спан станет не дочерним, а соседом или корнем. В .NET эту ошибку за тебя закрывает `AsyncLocal`, в Go — только дисциплина.

### Провайдер: SDK или no-op

Код открывает спаны через **API** (`go.opentelemetry.io/otel/trace`), а записывает и отправляет их **SDK** (`go.opentelemetry.io/otel/sdk/trace`). Между ними стоит `TracerProvider`. Без адреса OTLP Identity получает провайдер-заглушку:

```go
type noopTracesProvider struct{ tracenoop.TracerProvider }
```

Заглушка не бесплатная тишина, у неё есть поведение. Её `Start` не открывает своего спана, но **сохраняет в контексте спан-контекст родителя**. Если RPC пришёл с `traceparent` от бота, внутри обработчика в `ctx` лежит контекст бота. Это требование спецификации, а не случайность (`trace/noop/noop.go`, `Tracer.Start`: «If ctx contains a span context, the returned span will also contain that span context»).

Отсюда различие двух проверок:

- `SpanContext().IsValid()` отвечает «в контексте есть какой-то трейс», в том числе чужой.
- `IsRecording()` отвечает «в контексте есть спан, который этот процесс записывает».

Outbox пишет в строку только второй случай:

```go
if !trace.SpanFromContext(ctx).IsRecording() {
	return ""
}
```

На ревью PER-373 первая версия проверяла `IsValid` и при выключенном экспорте записала бы в outbox span id бота.

### Сэмплер решает, записывается ли спан

SDK по умолчанию берёт сэмплер `ParentBased(AlwaysSample())` (`sdk/trace/provider.go`). Он следует решению родителя: пришёл `traceparent` с флагом `01` — спан записывается, с флагом `00` — нет (`remoteParentNotSampled: NeverSample()`). Незаписываемый спан валиден, у него есть `TraceID` и `SpanID`, но в бэкенд он не уйдёт. Ссылка на такой спан вела бы в пустоту. Поэтому и здесь та же проверка `IsRecording`.

### Пропагация: `traceparent` на границе процесса

Между процессами контекст едет заголовком W3C `traceparent`: `00-<trace id 32 hex>-<span id 16 hex>-<флаги>`. Код, который кладёт контекст в заголовки и достаёт обратно, называется **пропагатором**.

У OpenTelemetry Go есть глобальный пропагатор, и по умолчанию он пустой: составной пропагатор без членов, который ничего не извлекает (`internal/global/propagator.go`, `noop: propagation.NewCompositeTextMapPropagator()`). Библиотеки инструментирования берут его, если им не дали другого. У otelgrpc это прямо в конфигурации: `Propagators: otel.GetTextMapPropagator()`. Без явной настройки сервер молча начинал бы каждый вызов новым трейсом.

Identity даёт пропагатор явно и в gRPC, и в outbox:

```go
otelgrpc.WithPropagators(propagation.TraceContext{}),
```

```go
propagation.TraceContext{}.Inject(ctx, carrier)
```

Глобальный при этом не нужен вовсе. Первая версия его ставила, и ось корректности на ревью заметила, что его никто не читает: комментарий обещал защиту, которой код не давал.

### Stats handler раньше интерцепторов

Интерцептор gRPC — это middleware вокруг обработчика ([grpc/unary-server.md](../grpc/unary-server.md)). У gRPC Go есть второй механизм — **stats handler**: объект, который сервер уведомляет о событиях RPC (начало, заголовки, конец). otelgrpc подключается именно так:

```go
grpc.StatsHandler(tracingHandler(cfg.tracerProvider)),
```

Его `TagRPC` вызывается до цепочки интерцепторов: извлекает `traceparent`, применяет фильтр и открывает серверный спан (`stats_handler.go`, `TagRPC`). Поэтому к моменту работы интерцепторов спан уже в `ctx`, и простой интерцептор может дописать в него `request_id`:

```go
trace.SpanFromContext(ctx).SetAttributes(attribute.String(requestIDAttribute, id))
```

По той же причине мост логов `otelslog` ставит в запись границы `trace_id`: запись пишется в интерцепторе, а спан уже есть.

Закрывается серверный спан на событии `*stats.End`, которое приходит после отправки статуса клиенту. Клиент может получить ответ раньше, чем спан попадёт в завершённые. Это видно в тестах, см. «Проверь себя».

### Трассировщик pgx и передача спана через контекст

pgx зовёт трассировщик дважды на запрос. Второй вызов получает тот `ctx`, который вернул первый (`conn.go`: `ctx = c.queryTracer.TraceQueryStart(...)`, затем `c.queryTracer.TraceQueryEnd(ctx, ...)`). Других каналов между вызовами нет, поэтому свой спан трассировщик кладёт в контекст под собственный ключ:

```go
return context.WithValue(ctx, querySpanKey{}, span)
```

```go
span, ok := ctx.Value(querySpanKey{}).(trace.Span)
if !ok {
	return
}
```

`trace.SpanFromContext` здесь опасен. Если родителя не было и трассировщик спана не открыл, в `ctx` лежит спан вызывающего, то есть серверный спан RPC, и `End` закрыл бы его на первом же SQL-запросе. Пустая структура `querySpanKey{}` как ключ — идиома Go: значение другого пакета с этим ключом не совпадёт, а памяти пустой тип не занимает.

### Ссылка (link) вместо родителя

У спана один родитель, но любое число **ссылок**: ссылка говорит «связан с тем спаном», не встраивая спан в чужое дерево. Релей открывает спан публикации корнем нового трейса и ссылается на запрос:

```go
trace.WithNewRoot(),
trace.WithSpanKind(trace.SpanKindProducer),
```

```go
opts = append(opts, trace.WithLinks(link))
```

Контекст запроса доживает до тика релея через колонку `identity_outbox.traceparent`: запрос пишет её в своей транзакции, релей читает. Другого носителя между ними нет: запрос давно ответил, процесс мог перезапуститься, а публиковать может другой экземпляр.

## Урок

- Контекст трассировки через асинхронную границу — очередь, outbox, отложенную задачу — переносится **данными**, а не памятью процесса, и связывается **ссылкой**, а не родителем. Это верно в любом стеке: в .NET тот же выбор между `ActivityLink` и `parentContext`.
- «В контексте есть трейс» и «этот процесс пишет спан» — разные вопросы. Код, который сохраняет или связывает контекст, проверяет второй.
- Инструментирование по умолчанию берёт глобальное состояние: пропагатор, провайдер. Явная передача делает поведение видимым в месте вызова и тестируемым без глобалов. Глобальное состояние, которое никто не читает, — ложное обещание, а не страховка.
- Хук вида «начало — конец», связанный только контекстом, ищет своё состояние по своему ключу, а не по общему «текущему» значению.

## Почему так, а не иначе

- **Родитель вместо ссылки.** Трейс запроса показывал бы публикацию внутри себя, но цена высокая. Тик публикует записи разных запросов, а родитель у спана один. Публикация идёт после ответа и повторяется при отказе шины, поэтому в закрытом трейсе появлялись бы спаны через секунды и минуты после корня. Семантические конвенции OpenTelemetry для асинхронного messaging рекомендуют ссылку. Сам otelgrpc делает так же для публичных точек входа: опция `WithPublicEndpoint` превращает входящий контекст в ссылку на новый корень (`stats_handler.go`, `TagRPC`).
- **Карта «событие → спан» в памяти.** Дешевле схемы, но теряется при рестарте и не работает, когда публикует другой экземпляр релея.
- **Корреляция атрибутом `event_id` без ссылки.** Схема не меняется, но это поиск по значению, а не связь: бэкенд не покажет переход от публикации к запросу.
- **`otelpgx` вместо своего трассировщика.** Готовая сторонняя библиотека, но она открывает спаны и без родителя. Тик релея раз в секунду делал бы корневые трейсы, и без обёртки не обойтись. Свой трассировщик на ~80 строк держит оба правила — «нет родителя — нет спана» и «параметры не пишутся» — в одном месте под unit-тестом.
- **Интерцептор otelgrpc вместо stats handler.** Выбора здесь уже нет: в otelgrpc v0.69.0 интерцепторов трассировки нет вовсе, в `interceptor.go` остались только вспомогательные функции, а точка входа одна — `NewServerHandler`. Проверка: `grep -n "^func " "$(go list -m -f '{{.Dir}}' go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc)/interceptor.go"`.

## Схема

```mermaid
sequenceDiagram
    participant Bot as Telegram Bot
    participant Srv as Identity gRPC
    participant DB as PostgreSQL
    participant Relay as Relay outbox
    participant JS as JetStream

    Bot->>Srv: ResolveIdentity + traceparent
    Note over Srv: stats handler: серверный спан<br/>в трейсе бота
    Srv->>DB: INSERT profile, INSERT outbox<br/>(дочерние спаны; traceparent в строку)
    Srv-->>Bot: ответ
    Note over Relay: тик: SQL вне спана не трассируется
    Relay->>DB: читает строку с traceparent
    Note over Relay: спан publish: новый корень,<br/>link на спан запроса
    Relay->>JS: publish
    Relay->>DB: UPDATE published_at (дочерний спан publish)
```

## Первоисточники

- [Trace API: behavior in the absence of an installed SDK](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/trace/api.md#behavior-of-the-api-in-the-absence-of-an-installed-sdk). Зачем идти: почему no-op трейсер возвращает контекст родителя, а не пустой спан.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/). Зачем идти: формат `traceparent` и смысл флага `sampled`, на которых стоит `CHECK` колонки и условие `IsRecording`.
- [Semantic conventions for messaging spans](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/). Зачем идти: почему публикация связывается ссылкой и какие атрибуты `messaging.*` ставит релей.
- [otelgrpc](https://pkg.go.dev/go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc). Зачем идти: опции stats handler — фильтр, пропагатор, `WithPublicEndpoint`.
- [pgx `QueryTracer`](https://pkg.go.dev/github.com/jackc/pgx/v5#QueryTracer). Зачем идти: контракт двух вызовов, связанных только `ctx`.
- [ADR-053](../../decisions/ADR-053-production-observability-otlp-better-stack.md) и раздел «Outbox и релей» в [services/identity.md](../../services/identity.md#outbox-и-релей). Зачем идти: почему трейсы понадобились и что решено про колонку. Разбор это объясняет, но не задаёт.

## Проверь себя

Команды — из `apps/identity`.

1. **Что вернёт `outbox.TraceParent` для контекста, где есть только удалённый контекст вызывающего, без своего спана?** Ответ: пустую строку, `IsRecording` ложно. Проверка: `go test ./internal/outbox -run TestTraceParentNeedsARecordingSpan -v`.
2. **Станет ли спан публикации дочерним, если тик релея идёт внутри чужого спана?** Ответ: нет, `WithNewRoot` делает его корнем, связь с запросом только ссылкой. Проверка: `go test ./internal/relay -run TestPublishSpanLinksToRequestTrace -v`.
3. **Закроет ли `TraceQueryEnd` спан RPC, если запрос пришёл без родителя и трассировщик своего спана не открыл?** Ответ: нет, он ищет спан по `querySpanKey{}`. Проверка: `go test ./internal/migrations -run TestQueryInsideSpanRecordsChildWithoutArguments -v` — тест требует, чтобы родитель оставался записываемым.
4. **Почему тест «health не трассируется» смотрит в `recorder.Started()`, а не в `Ended()`?** Ответ: серверный спан открывается до обработчика, а закрывается после ответа клиенту. Пустой `Ended()` сразу после ответа ничего не доказывает, а пустой `Started()` — окончательный. Проверка: `go test ./internal/server -run TestHealthCheckIsNotTraced -v`. Тест ловит дефект: с фильтром, который пропускает health (`filters.Not(filters.MethodName("none"))` вместо `filters.Not(filters.HealthCheck())`), он падает с `spans: got 1 want 0` — проверено.
5. **Что покажет Aspire Dashboard для `ResolveIdentity` из бота?** Ответ: один трейс с корнем `telegram.update message` в боте; под ним клиентский спан бота `identity.v1.IdentityService/ResolveIdentity` и уже под ним серверный спан Identity, потому что interceptor бота кладёт `traceparent` в заголовки вызова. Проверка: `aspire run -- --profile hub`, затем `/start` боту и вкладка Traces.
