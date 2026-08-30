# Unary gRPC-сервер

Скелет Identity поднимает один процесс, который слушает gRPC и отвечает на `ResolveIdentity` заглушкой. Устройство контракта — в [identity.md](../../services/identity.md) и [integration.md](../../architecture/integration.md). Раскладка модуля и лог — в [service-layout.md](../go/service-layout.md).

## Что появилось и зачем

`server.New` собирает `grpc.Server`, регистрирует сгенерированный `IdentityService`, стандартный `grpc.health.v1` и reflection. Хендлер встраивает `UnimplementedIdentityServiceServer`: новый RPC в `.proto` без реализации не оставит пустой метод, а вернёт `Unimplemented`.

Заглушка в `resolve.go` принимает только `telegram_user_id > 0` и возвращает фиксированный UUIDv7 `0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd` с пустым `global_roles`. Отказ — `status.Error(codes.InvalidArgument, ...)`. Сырой `error` стал бы `Unknown`, и клиент не отличил бы его от сбоя.

Interceptor'ы стоят парой в `ChainUnaryInterceptor` и такой же парой в `ChainStreamInterceptor`: сначала logging, затем recovery. Первый в цепочке — внешний, поэтому recovery успевает превратить панику в `Internal` до того, как logging запишет строку, и запись доступа у паники такая же полная, как у обычного отказа. Stream-пара обязательна: `Health/Watch` и `ServerReflectionInfo` — потоковые методы, и `ChainUnaryInterceptor` их не видит вовсе; паника в таком хендлере без recovery уносит процесс.

Logging пишет `service`, `operation` (`info.FullMethod`), `result`, `duration_us`; для `ResolveIdentity` ещё `telegram_user_id`; ник не берётся. Микросекунды, а не миллисекунды: заглушка отвечает за десятки микросекунд, и `Milliseconds()` писал бы `0` в каждую строку. Если в metadata есть `x-request-id` или `x-correlation-id`, поле `request_id` едет в ту же запись. Успех — `Debug`, поэтому при уровне процесса `Info` успешного вызова в stdout нет.

Уровень отказа выбирает `serverFault`: `Internal`, `Unknown`, `Unavailable` и `DataLoss` — `Error` и `error_category: server_error`, всё остальное — `Warn` и `client_error`. Это требование [logging.md](../../standards/observability/logging.md): «ожидаемый отказ входных данных — `Warning`». `NotFound`, которым `grpc.health.v1` отвечает на неизвестное имя сервиса, — именно такой отказ, и на `Error` он поднимал бы алерт на здоровом процессе. Отдельная строка `rpc panic` несёт `debug.Stack()`: без кадров значение паники не указывает на место отказа.

Health выставляет `SERVING` на пустое имя (весь процесс) и на `identity.v1.IdentityService`. Reflection нужна, чтобы `grpcurl` без `-proto` умел `list` и `describe`. Тесты гоняют тот же `server.New` через `bufconn`: in-memory listener, полный стек сериализации и interceptor'ов, без TCP.

## Почему так, а не иначе

| Вариант | Цена |
|---|---|
| HTTP `/health` рядом с gRPC | второй порт и второй протокол на скелете, у которого единственный клиентский путь — gRPC. Задача сказала «health endpoint»; для gRPC это [health checking protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md) |
| Выключить reflection | `grpcurl list` без локальных `.proto` не видит сервисы. На скелете без production-контура reflection оставляют; в проде её обычно гасят, потому что она отдаёт полный список методов |
| Случайный UUIDv7 на каждый вызов | `grpcurl` и тест перестают быть детерминированными; схема и запись профиля — следующие задачи |
| `error_category` = код gRPC | дублирует `result` слово в слово; категория нужна как грубый класс, по которому группируется алерт |
| Только unary-interceptor'ы | `Health/Watch` и `ServerReflectionInfo` остаются без recovery: паника в них не станет `Internal`, а уронит процесс |
| Логировать username из запроса | нарушает [logging.md](../../standards/observability/logging.md): в лог идёт технический идентификатор, не атрибут профиля Telegram |
| Тест через реальный порт | гонки за `:50051`, зависимость от файрвола; `bufconn` проверяет тот же `New` |
| Не встраивать `Unimplemented*` | компилятор не заставит заметить новый RPC; вызов уйдёт в отсутствующий метод |

## Схема

```mermaid
sequenceDiagram
    participant C as grpcurl
    participant R as reflection / health
    participant L as logging interceptor
    participant H as ResolveIdentity

    C->>R: Health/Check или list
    R-->>C: SERVING либо список сервисов
    C->>L: ResolveIdentity
    L->>H: telegram_user_id
    alt id > 0
        H-->>L: identity_id заглушки
        L-->>C: OK; лог только на Debug
    else id <= 0
        H-->>L: InvalidArgument
        L-->>C: InvalidArgument; Warn + request_id если был
    end
```

## Первоисточники

- [gRPC health checking protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md) — `Check`, пустое имя сервиса, `SERVING` / `NOT_SERVING` / неизвестный сервис.
- [`google.golang.org/grpc/health`](https://pkg.go.dev/google.golang.org/grpc/health) — `NewServer` и `SetServingStatus` в диффе.
- [`google.golang.org/grpc/reflection`](https://pkg.go.dev/google.golang.org/grpc/reflection) — почему `grpcurl` без `-proto` отвечает на `list`.
- [`grpc.ChainUnaryInterceptor`](https://pkg.go.dev/google.golang.org/grpc#ChainUnaryInterceptor) — порядок: первый аргумент снаружи.
- [Status codes](https://grpc.io/docs/guides/status-codes/) — зачем `InvalidArgument`, а не сырой `error`.
- [`bufconn`](https://pkg.go.dev/google.golang.org/grpc/test/bufconn) — in-memory transport в `server_test.go`.
- [Proto3 JSON mapping](https://protobuf.dev/programming-guides/json/) — почему `grpcurl` печатает `identityId`, а в `.proto` поле `identity_id`.

## Проверь себя

- `grpcurl -plaintext 127.0.0.1:50051 list` показывает `identity.v1.IdentityService` и `grpc.health.v1.Health`. Проверено на живом `just identity-run`.
- `Health/Check` без `service` и с `identity.v1.IdentityService` → `SERVING`. С `no.such.Service` → `NotFound` / `unknown service`. Проверено.
- `ResolveIdentity` с `telegram_user_id: 1` → `{"identityId":"0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd"}`. Нулевой id → `InvalidArgument`. Проверено.
- `-H 'x-request-id: learn-1'` на отказе даёт в stdout поле `request_id":"learn-1"`. Успешный вызов при `LevelInfo` новой строки `rpc completed` не пишет. Проверено.
- Тот же RPC с `-import-path contracts/proto -proto identity/v1/identity_service.proto` работает и без reflection. Проверено.
- Паника в хендлере становится `Internal`, а в stdout уходит `rpc panic` со стеком: `TestUnaryRecoveryConvertsPanicToInternalWithStack` и `TestStreamRecoveryConvertsPanicToInternal` в `internal/server/interceptor_test.go`. Проверено `go test`.
- `NotFound` от Health пишется на `Warn`, `Internal` — на `Error`: `TestUnaryLoggingLevelByCode`. Проверено `go test`.
