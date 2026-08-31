# Standard: Protobuf-контракты

> **Статус:** Active  
> **Применимость:** `contracts/proto/`, все NATS/gRPC producers и consumers  
> **Связанные документы:** ADR-012, ADR-014, ADR-025, [integration.md](../../architecture/integration.md)

`contracts/proto/` — единственный источник wire-схем межсервисного обмена.

## Совместимость

- Не меняй тип или номер существующего поля несовместимым образом.
- Не переиспользуй номер удалённого поля; помечай удалённые номера и имена как `reserved`.
- Новое поле добавляй так, чтобы старый consumer мог его проигнорировать, а новый consumer корректно обработал отсутствие значения.
- Breaking change требует явного решения о версии или миграции потребителей до изменения схемы.
- Идентификаторы сущностей передаются канонической lowercase UUIDv7-строкой с дефисами обычным `string`. Обёрточное сообщение вокруг идентификатора не заводится: оно не даёт ни одного инварианта, а стоит указателя и nil-проверки у каждого потребителя. Каноническую форму сейчас гарантирует сервис; машинно-проверяемые ограничения полей остаются открытым вопросом в [integration.md](../../architecture/integration.md).

## Transport

- NATS и gRPC payload сериализуется только в Protobuf.
- JSON на межсервисном NATS path запрещён.
- Имя NATS subject не является частью `.proto`; оно документируется в [integration.md](../../architecture/integration.md) и задаётся константой или конфигурацией producer/consumer.
- Subjects именуются `<commands|events>.<домен>.<действие>` в `snake_case`.

## Раскладка и пакеты

- Схема лежит в `contracts/proto/<domain>/v<major>/<file>.proto`, где `<domain>` — домен-владелец, а не транспорт.
- Protobuf package повторяет путь: `<domain>.v<major>`, например `identity.v1`. Каталог и package расходиться не должны — на этом держатся `buf lint` и вывод import path в managed mode.
- Транспорт каталогом и частью package не является. То, что операция идёт по gRPC, а не по NATS, документируется в [integration.md](../../architecture/integration.md).
- Организационного префикса в package нет: все потребители свои, Buf Schema Registry вне build path. Появится внешняя публикация — префикс вводится вместе с новым major.
- Несовместимая версия — новый каталог и package `v<major+1>`, а не правка существующего.
- Корень buf-модуля — `contracts/proto/`. Потребитель не переносит корень: от него считаются пути в `import`. Go сужает генерацию фильтром `paths` в `buf.gen.yaml` и считает от него же `go_package` в managed mode. TypeScript задаёт тот же корень как `inputs.directory` в своём `buf.gen.yaml`. .NET задаёт тот же корень как `ProtoRoot` у элемента `Protobuf`.
- В `.proto` нет языковых `option` вроде `go_package`: их задаёт потребитель через managed mode.

## Комментарии

Комментарий в `.proto` описывает то, без чего потребитель неправильно соберёт или разберёт сообщение: кодировку, каноническую форму значения, семантику отсутствия и то, чего в сообщении сознательно нет. Правила домена, поведение сервиса и условия отказа живут в service brief и [integration.md](../../architecture/integration.md), а не в схеме.

Комментарии пишутся на английском: их читают в сгенерированном коде на всех языках потребителей.

Причина в том, что потребитель видит не схему, а сгенерированный тип на своём языке: `protoc-gen-go` переносит комментарии в doc-комментарии Go. Отрицательные утверждения о составе сообщения нигде больше не выражаются и потому особенно полезны.

## Кодогенерация Go

- Go-потребители вызывают `buf generate` как единый frontend кодогенерации. Конфигурация конкретного потребителя хранится в его `buf.gen.yaml`.
- Код генерируют локальные официальные плагины `protoc-gen-go` и `protoc-gen-go-grpc` с закреплёнными версиями. Remote plugins и Buf Schema Registry не входят в build path.
- Версии закреплены в одном месте на инструмент: `buf` — переменной `BUF_VERSION` в корневом `justfile`, плагины — директивой `tool` в `apps/identity/go.mod`. Джоба `identity` в CI читает `BUF_VERSION` из `justfile`, а не дублирует значение. Установка — `just identity-proto-tools`.
- Сгенерированный код находится в отдельном пакете `gen/`, не содержит рукописного кода и не является источником правды.
- Для Identity команда из корня репозитория — `buf generate --template apps/identity/buf.gen.yaml`. Её оборачивают рецепт `just identity-proto` и локальная, CI- и container-сборка сервиса; Aspire запускает уже подготовленный Go-процесс и сам кодогенерацию не выполняет.
- `go_package_prefix` Identity — `github.com/Solguficky/solguficky-hub/apps/identity/gen`. К нему добавляется путь файла относительно корня модуля, поэтому схема `identity/v1/` даёт Go-пакет `.../gen/identity/v1`.

Buf выбран вместо прямого вызова `protoc`, потому что генерирует код теми же Go-плагинами, но хранит список входов и параметры декларативно и оставляет единый путь к `buf lint` и `buf breaking`. Эти проверки не включаются самим выбором генератора: contract CI с lint и compatibility gate вводится отдельным изменением.

## Кодогенерация .NET

- .NET-потребители генерируют C# штатным `Grpc.Tools` внутри MSBuild. `buf generate` для C# не вызывается. Форма сгенерированного кода — отдельный C#-проект без рукописных строк, на который ссылается F#-сервис; это [ADR-025](../../decisions/ADR-025-meetups-fsharp-stack.md).
- Сообщения даёт встроенный генератор `protoc --csharp_out`, стабы — `grpc_csharp_plugin`. Оба бинарника поставляет пакет `Grpc.Tools`; отдельного `protoc-gen-csharp` в build path нет. Remote plugins и Buf Schema Registry не входят в build path.
- Версии `protoc` и `grpc_csharp_plugin` закреплены одним `PackageReference` на `Grpc.Tools` в контрактном C#-проекте потребителя. Рантайм-пакеты `Google.Protobuf` и `Grpc.*` закрепляются рядом отдельными ссылками.
- Сгенерированный код — артефакт сборки в `obj/`, не коммитится и не является источником правды. В контрактном проекте нет рукописного C#.
- `import` резолвится от корня модуля: у каждого элемента `Protobuf` атрибут `ProtoRoot` указывает на `contracts/proto/`, а путь в `Include` лежит внутри этого корня. Well-known types .NET берёт из поставки `Grpc.Tools`, не из buf-модуля.
- Для сборки Meetups команда генерации — `dotnet build` контрактного C#-проекта. Локальная, CI- и container-сборка сервиса включают эту команду; Aspire запускает уже подготовленный процесс и сам кодогенерацию не выполняет.

Генерацию запускает `dotnet build` через `Grpc.Tools`, потому что C#-генератор встроен в `protoc`, а `grpc_csharp_plugin` — нативный бинарник из того же NuGet: вызов через `buf generate` не убирает `Grpc.Tools`, а оркестрирует его бинарники вторым toolchain. `buf generate` — frontend там, где это удобнее прямого вызова плагина: сейчас у Go и TypeScript. C# идёт через `Grpc.Tools`. Цена двух frontend: в репозитории два `protoc` — `BUF_VERSION` у Go и TypeScript и тот, что внутри `Grpc.Tools`; синтаксис схемы, который принимает один, другой может отвергнуть. `buf lint` и breaking check проверяют схемы, а не C# codegen.

## Кодогенерация TypeScript

- TypeScript-потребители вызывают `buf generate`. Конфигурация конкретного потребителя хранится в его `buf.gen.yaml`. Это удобный способ запустить локальный `protoc-gen-es`, а не правило на все языки: C# по той же причине удобства остаётся на `Grpc.Tools`.
- Сообщения и schema сервиса генерирует локальный официальный плагин `protoc-gen-es` с рантаймом `@bufbuild/protobuf`. RPC-клиент — Connect с транспортом gRPC: пакеты `@connectrpc/connect` и `@connectrpc/connect-node`, вызов `createGrpcTransport`. Identity отвечает обычным gRPC поверх HTTP/2; протокол Connect к нему не применяется. Remote plugins и Buf Schema Registry не входят в build path.
- Версии закреплены в одном месте на инструмент: `buf` — переменной `BUF_VERSION` в корневом `justfile`, плагин `protoc-gen-es`, рантайм и Connect — в `package.json` потребителя. Джоба CI читает `BUF_VERSION` из `justfile`, а не дублирует значение; npm-пакеты ставит `npm ci` того же `package.json`.
- Сгенерированный код находится в отдельном каталоге `gen/`, не содержит рукописного кода и не является источником правды.
- Для сборки Telegram Bot команда из корня репозитория — `buf generate --template apps/telegram-bot/buf.gen.yaml`. Плагин вызывается как `local: apps/telegram-bot/node_modules/.bin/protoc-gen-es`, чтобы генерация не зависела от `PATH`. Рецепт `just` и джоба CI появятся вместе со скелетом сервиса; Aspire запускает уже подготовленный процесс и сам кодогенерацию не выполняет. Каталог `apps/telegram-bot` этой нормой не заводится.
- Well-known types TypeScript берёт из `@bufbuild/protobuf/wkt`, а не генерирует `google/protobuf` в `gen/`. `import` резолвится от корня модуля: `inputs.directory` указывает на `contracts/proto/`, фильтр `paths` сужает генерацию так же, как у Go.

Прямой вызов `protoc-gen-es` неудобнее: нужны `PATH`, `--proto_path` и список файлов. `buf generate` держит входы от корня модуля и локальный плагин декларативно. Клиент Connect с `createGrpcTransport` говорит с Identity обычным gRPC; протокол Connect сервер не принимает.

## Изменение контракта

- Найди producers, consumers, тестовые инструменты и generated-code configuration по имени сообщения и subject.
- Обнови всех затронутых потребителей в одном изменении.
- Пересобери каждый затронутый сервис, чтобы выполнить кодогенерацию.
- Обнови `tools/nats-tester`, если он поддерживает изменённое сообщение.
- Обнови `architecture/integration.md` при добавлении или изменении subject либо gRPC-операции.

Пошаговый workflow находится в skill `proj-change-contract`.
