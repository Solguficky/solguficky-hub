# RFC-007: Кодогенерация Protobuf для TypeScript

> **Статус:** Accepted, раздел «Кодогенерация TypeScript» в [protobuf.md](../standards/contracts/protobuf.md#кодогенерация-typescript)
> **Автор:** агент по задаче [PER-93](https://linear.app/anticnvm/issue/per-93)
> **Дата:** 2026-08-31

## Кратко

Telegram Bot на TypeScript должен генерировать типы из `contracts/proto/` той же командой `buf generate`, что и Identity, локальными плагинами и без Buf Schema Registry. Сравниваются генератор сообщений и gRPC-клиент отдельно. Принятая связка: **`protoc-gen-es` с рантаймом `@bufbuild/protobuf` и клиент Connect с транспортом gRPC** (`createGrpcTransport`). Identity по-прежнему отвечает обычным gRPC поверх HTTP/2; протокол Connect к нему не применяется.

## Проблема и границы

[PER-48](https://linear.app/anticnvm/issue/per-48) поднимет скелет бота и обязан подключить кодогенерацию, не выбирая плагин. Стандарт описывает только Go и .NET; [integration.md](../architecture/integration.md) держал TypeScript открытым пунктом codegen matrix. [ADR-030](../decisions/ADR-030-telegram-bot.md) закрепил TypeScript + grammY, но не генератор.

В границах: генератор сообщений, RPC-клиент к Identity, как это ложится на `buf generate` из корня модуля, закрепление версий и будущую джобу CI.

Вне границ: кодогенерация F# ([PER-94](https://linear.app/anticnvm/issue/per-94), [ADR-025](../decisions/ADR-025-meetups-fsharp-stack.md)); заведение `apps/telegram-bot` ([PER-48](https://linear.app/anticnvm/issue/per-48)); пересмотр `buf` как frontend; remote plugins и Buf Schema Registry.

ADR не заводится: откат — смена `buf.gen.yaml` и перегенерация изолированного `gen/`, без миграции данных и без смены wire-схемы. Норматив живёт в стандарте, сравнение — здесь.

## Сценарии и требования

- из корня репозитория `buf generate --template <потребитель>/buf.gen.yaml` читает `contracts/proto/` и пишет TypeScript в `gen/` потребителя;
- плагин локальный, версия закреплена, remote plugins не вызываются;
- `IdentityService.ResolveIdentity` вызывается как обычный gRPC unary по HTTP/2, без смены протокола сервера;
- те же типы сообщений пригодны для будущего NATS-потребителя: RPC-схема не обязательна, чтобы разобрать payload;
- `oneof` уведомлений ([ADR-031](../decisions/ADR-031-meetups-domain-vocabulary-and-event-form.md)) разбирается исчерпывающе, well-known types не требуют копировать `google/protobuf` в `gen/`.

## Варианты

### Генератор сообщений

Оба плагина вызываются как `local` из `buf.gen.yaml` v2. Проверено из корня репозитория на `identity/v1` и на фикстуре с `oneof`, `optional`, `google.protobuf.Timestamp`, `StringValue` и `Empty`. Версии эксперимента: `protoc-gen-es` / `@bufbuild/protobuf` 2.14.0, `ts-proto` 2.12.1, `buf` 1.54.0.

| | `protoc-gen-es` + `@bufbuild/protobuf` | `ts-proto` |
|---|---|---|
| Форма сообщения | тип + schema; конструктор `create(Schema)`, сериализация рантаймом | `interface` + объект с `encode`/`decode`/`fromJSON` |
| `int64` | `bigint` | `number`, падает за пределами `MAX_SAFE_INTEGER` |
| `optional` | `field?: T` | `field?: T` |
| enum | префикс снимается: `GlobalRole.ADMIN` | полное имя: `GlobalRole.GLOBAL_ROLE_ADMIN` |
| `oneof` | дискриминированный союз `{ case, value }`, пустой `{ case: undefined }` | по умолчанию плоские поля; с `oneof=unions-value` — `{ $case, value } \| undefined` |
| Timestamp | сообщение `{ seconds: bigint, nanos }`, дата через `@bufbuild/protobuf/wkt` | сразу `Date` |
| wrappers / Empty | `StringValue` разворачивается в `string \| undefined`; WKT из рантайма, в `gen/` не копируются | wrappers тоже разворачиваются; `include_imports` пишет `google/protobuf/*.ts` |
| сервис | только schema `GenService`; транспорт не генерируется | при `outputServices=grpc-js` — callback-клиент `@grpc/grpc-js` |
| размер `identity_service` | 3.9 КБ | 12 КБ |
| размер фикстуры с WKT | 4.2 КБ | 52 КБ |
| unpacked runtime | `@bufbuild/protobuf` 1.9 МБ | `@bufbuild/protobuf/wire` уже внутри 2.x, плюс 0.8 МБ самого генератора в dev |

Wire обоих генераторов на одной и той же `oneof`+Timestamp фикстуре совпал байт в байт; взаимный decode прошёл. `ts-proto` 2.x сериализует через `@bufbuild/protobuf/wire`, то есть сообщество-генератор уже сидит на рантайме Buf.

### RPC-клиент

Identity — `grpc-go` на `:50051` без TLS. Проверено живым вызовом `ResolveIdentity` заглушки.

| | Connect, `createGrpcTransport` | `@grpc/grpc-js` | Connect-протокол (`createConnectTransport`) |
|---|---|---|---|
| Протокол на проводе | gRPC / HTTP/2 | gRPC / HTTP/2 | Connect (JSON или proto, другой Content-Type) |
| Результат к Identity | `identity_id` заглушки, `InvalidArgument` на нулевом user id | то же, код 3 | HTTP 415 |
| API | `createClient(Service, transport)`, промисы | сгенерированный класс, callback | те же промисы, другой транспорт |
| unpacked | `@connectrpc/connect` 0.86 МБ + `connect-node` 0.21 МБ | 2.5 МБ | те же пакеты Connect |
| стек I/O | `node:http2` | свой HTTP/2 в `@grpc/grpc-js` | `node:http2` |

Протокол Connect к Identity не подходит: сервер его не говорит. Это не аргумент против библиотеки Connect — у неё отдельный gRPC-транспорт, и именно он проверен.

Естественные пары: `protoc-gen-es` + Connect; `ts-proto` + `@grpc/grpc-js`. Скрещивать пары — отдельный слой отображения schema ↔ stub.

### Frontend, версии, CI

`buf generate --template …` с `inputs.directory: contracts/proto` работает для обоих плагинов так же, как у Go. Путь `local:` может указывать на бинарь в `node_modules/.bin` потребителя: тогда `PATH` для плагина не нужен. Remote plugin не вызывался.

Версии: `buf` уже закреплён `BUF_VERSION` в корневом `justfile`; плагин и рантайм TypeScript — в `package.json` потребителя, когда появится [PER-48](https://linear.app/anticnvm/issue/per-48). Джоба CI для бота не заводится этой задачей. Когда скелет появится, она читает `BUF_VERSION` из `justfile`, как `identity`, ставит Node по `package.json` и вызывает ту же команду генерации.

## Предложение

Взять **`protoc-gen-es` + `@bufbuild/protobuf` + Connect с `createGrpcTransport`**.

- один локальный плагин даёт и сообщения, и schema сервиса; отдельный `protoc-gen-connect-es` в v2 не нужен;
- `oneof` по умолчанию — алгебраический тип, без опции, которую легко забыть; это та форма, которой будут пользоваться уведомления;
- well-known types не плодят `google/protobuf` в `gen/`;
- `int64` как `bigint` не теряет идентификатор за `Number.MAX_SAFE_INTEGER`;
- клиент говорит с Identity обычным gRPC, сервер не меняется; это проверено на заглушке, а не выведено из документации;
- Generators в контрактном контуре — то место, где [ADR-025](../decisions/ADR-025-meetups-fsharp-stack.md) отказался от community-генератора ради штатного. `ts-proto` здесь тот же риск: опций много, сопровождение не Buf, а 2.x уже зависит от `@bufbuild/protobuf`.

`ts-proto` + `@grpc/grpc-js` отвергается не потому, что не работает: оба живые вызовы к Identity прошли. Цена — callback-API, `int64` как `number`, генерация WKT в `gen/`, более тяжёлый HTTP/2-стек и community-плагин в том же месте, где у Go уже стоит официальный.

Протокол Connect не выбирается и не предлагается Identity. Браузерный Mini App вне MVP; когда появится, типы `protoc-gen-es` можно подать в `connect-web` отдельным решением транспорта.

## Что станет сложнее

- сгенерированный код требует schema рядом с типом: `create(ResolveIdentityRequestSchema, { … })`, а не «просто объект»;
- `google.protobuf.Timestamp` — не `Date`, нужен хелпер из `@bufbuild/protobuf/wkt`;
- Connect-ошибка оборачивается в `ConnectError`, а не в `ServiceError` grpc-js; маппинг статусов свой;
- третья джоба CI, когда появится бот, всё ещё ставит `buf` из `justfile` и Node из `package.json` — два toolchain, как уже есть у Go и .NET.

## Открытые вопросы

Закрыты этим RFC. ESM-суффикс импортов (`import_extension`) и точные версии npm выбирает скелет [PER-48](https://linear.app/anticnvm/issue/per-48) под свой `tsconfig`; стандарт фиксирует плагин, рантайм, транспорт и место закрепления.

## Результирующие артефакты

- ADR: не нужен;
- standard: раздел «Кодогенерация TypeScript» в [protobuf.md](../standards/contracts/protobuf.md);
- каталог: закрытый пункт codegen matrix в [integration.md](../architecture/integration.md);
- задачи Linear: скелет бота подключает генерацию в [PER-48](https://linear.app/anticnvm/issue/per-48).

## Технические источники

- [Generated features, Protobuf-ES](https://protobufes.com/reference/generated-code/features/) — `oneof`, schema сервиса;
- [Working with messages, Protobuf-ES](https://protobufes.com/guides/messages/) — `create`, presence;
- [`@bufbuild/protoc-gen-es`](https://www.npmjs.com/package/@bufbuild/protoc-gen-es) — локальный плагин и `target=ts`;
- [buf.gen.yaml v2, `plugins.local`](https://buf.build/docs/configuration/v2/buf-gen-yaml/) — строка или argv, без remote;
- [ts-proto: OneOf Handling, Well-Known Types, `outputServices=grpc-js`](https://github.com/stephenh/ts-proto);
- [Connect Node: `createGrpcTransport`](https://www.npmjs.com/package/@connectrpc/connect-node) — gRPC-протокол с `node:http2`;
- [Connect getting started: три протокола](https://connectrpc.com/docs/node/getting-started/).
