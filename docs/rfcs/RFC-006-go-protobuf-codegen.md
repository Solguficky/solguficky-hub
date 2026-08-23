# RFC-006: Кодогенерация Protobuf для Go

> **Статус:** In Review  
> **Автор:** агент, [PER-31](https://linear.app/anticnvm/issue/per-31)  
> **Дата:** 2026-08-23

## Кратко

[ADR-027](../decisions/ADR-027-identity-go-stack.md) оставил открытым, чем Identity генерирует Go-код из `contracts/proto`: `buf` или `protoc`. Identity — первый Go-сервис репозитория, поэтому команда сборки станет шаблоном для следующих.

Записка сравнивает варианты, называет цену и рекомендует `buf generate` с локальными плагинами. Решение принимает владелец. После принятия правило живёт в [protobuf.md](../standards/contracts/protobuf.md), а не в новом ADR.

## Проблема и границы

### Что вынуждает решать сейчас

Сборке Identity нужна конкретная команда генерации. Пока её нет, исполнитель первого контракта либо копирует флаги `protoc` из `tools/nats-tester`, либо заводит свой контур. Оба пути задают прецедент молча.

### Что в границах

- инструмент и команда генерации Go-кода в `gen/`;
- как выбор ложится на локальную сборку, CI и Aspire;
- что `buf` даёт сверх генерации и нужно ли это при [ADR-014](../decisions/ADR-014-protobuf-in-git.md).

### Что вне границ

- раскладка `contracts/proto` и именование пакетов — это первый контракт, не этот RFC;
- кодогенерация F# и TypeScript — решения своих сервисов;
- Schema Registry и публикация схем в Buf Schema Registry;
- включение `buf lint` / `buf breaking` в CI этим же решением.

## Исходные факты

`buf generate` не заменяет генератор: он вызывает те же `protoc-gen-go` и `protoc-gen-go-grpc`, что и прямой `protoc`. На проверочном `identity.v1` сервисе оба пути дали одинаковые `*.pb.go` и `*_grpc.pb.go`, которые собираются `go build`.

Текущие схемы в `contracts/proto/` — Legacy-аукцион. На `buf` 1.56.0:

| Набор правил | Результат на существующих `.proto` |
|---|---|
| `STANDARD` (умолчание) | шесть ошибок: пять `PACKAGE_VERSION_SUFFIX` и одна `PACKAGE_DIRECTORY_MATCH` |
| `MINIMAL` / `BASIC` | одна ошибка: `grpc/auction_service.proto` лежит в `grpc/`, а пакет — `grpc.auction` |
| тот же `STANDARD` на файле `identity/v1/identity.proto` | чисто |

`option go_package` в существующих схемах нет. У `buf` есть managed mode: префикс Go-пакета задаётся в `buf.gen.yaml` и не попадает в общий `.proto`. Прямой `protoc` без этой опции в каждом файле не генерирует.

Системный `protoc` из `apt` в этой среде — 3.21.12. Legacy Rust CI уже ставит `protobuf-compiler` для `prost-build`. C# несёт `protoc` внутри `Grpc.Tools`. Python `nats-tester` вызывает системный `protoc`.

Aspire запускает процесс, а не кодогенерацию. `go run` не вызывает `go generate`. Это цена Go-стека из ADR-027, а не различия `buf` и `protoc`: обёртка нужна любому варианту.

## Варианты

### A. `protoc` и `go generate`

Сборка Identity вызывает `protoc` с явными `-I`, `--go_out` и `--go-grpc_out`, либо через `//go:generate`. Плагины ставятся `go install` с пином версии. Так уже устроен `nats-tester`.

Команда, которую будет вызывать сборка:

```bash
protoc \
  -I contracts/proto \
  --go_out=apps/identity/gen --go_opt=paths=source_relative \
  --go-grpc_out=apps/identity/gen --go-grpc_opt=paths=source_relative \
  contracts/proto/<путь-к-новым-файлам>.proto
```

### B. `buf generate` с локальными плагинами

Тот же `protoc-gen-go` и `protoc-gen-go-grpc` на `$PATH`. Список плагинов и `out: gen` живёт в `apps/identity/buf.gen.yaml`. Модуль схем — `contracts/proto`, описывается корневым `buf.yaml`.

Команда, которую будет вызывать сборка:

```bash
buf generate --template apps/identity/buf.gen.yaml
```

Её же оборачивает будущий рецепт `just identity-proto` и `//go:generate` в Identity.

Предлагаемый шаблон, не коммитится до решения:

```yaml
version: v2
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: <go-module Identity>/gen
plugins:
  - local: protoc-gen-go
    out: gen
    opt: paths=source_relative
  - local: protoc-gen-go-grpc
    out: gen
    opt: paths=source_relative
```

`<go-module Identity>` появится вместе с `apps/identity`, не в этом RFC.

### C. `buf generate` с remote plugins

Та же команда `buf generate`, но плагины исполняет BSR: `remote: buf.build/protocolbuffers/go:v1.36.11` и `buf.build/grpc/go:v1.5.1`. Локально ставить `protoc-gen-*` не нужно. Схемы уходят на исполнитель Buf.

## Что `buf` даёт сверх генерации

| Возможность | Отношение к ADR-014 |
|---|---|
| `buf lint` | Проверяет стиль и раскладку, не совместимость на проводе. Git-источник схем не заменяет и не требует. На текущем дереве `STANDARD` сразу красный из-за Legacy-аукциона. |
| `buf breaking --against origin/develop` | Как раз тот compatibility check, который ADR-014 оставил открытым, а [integration.md](../architecture/integration.md) уже называет следующим уровнем после Git. Сравнивает с git-ref, Registry не нужен. |
| `buf format` | Форматирование `.proto`. Не блокирует сборку. |
| managed `go_package` | Убирает Go-специфику из общих схем. К ADR-014 не относится. |
| remote plugins / BSR | Реестр плагинов и схем — другое решение. ADR-014 отказался от runtime Registry; тащить схемы на чужой исполнитель при генерации — отдельная цена, не выигрыш. |

Lint и breaking **не нужны, чтобы сгенерировать `gen/`**. Они понадобятся, когда у Identity появится второй потребитель того же сообщения и агент начнёт править `.proto` без живого review каждого номера поля. Это работа из списка contract governance, не этот выбор.

Если взять B, тот же бинарь позже включает `buf breaking` без второго инструмента. Если взять A, breaking почти наверняка всё равно придёт как `buf` — и в репозитории окажутся оба контура.

## Локальная сборка, CI, Aspire

| Место | A. `protoc` | B. `buf` + local | C. `buf` + remote |
|---|---|---|---|
| Ноутбук | `protoc` + два плагина | `buf` + те же два плагина | только `buf`, нужен выход в `buf.build` |
| CI Identity | `setup-go`, `go install` плагинов, `apt` `protobuf-compiler` или свой `protoc` | `setup-go`, `go install` плагинов, поставить `buf` | поставить `buf`, egress на BSR |
| CI контрактов | нет lint/breaking, пока не добавим другой инструмент | тот же `buf`, отдельной job | тот же `buf`, плюс зависимость от BSR |
| Aspire Local | не вызывает генерацию; нужен скрипт `generate && go run` | то же | то же, и ещё сеть в момент generate |
| Container | плагины в образе сборки | `buf` и плагины в образе сборки | `buf` в образе, generate ходит наружу |
| Соседние стеки | C# и Rust не меняются | не меняются; `buf.yaml` можно завести, не включая lint | не меняются |

Текущий `.github/workflows/ci.yml` ещё смотрит в `services/`, которых нет. Новый job Identity появится вместе с сервисом и вызовет выбранную команду; чинить пути CI эта записка не берёт.

## Цена

**A.** Дешевле на старте: один знакомый бинарь уже есть в Rust-job и в `nats-tester`. Дороже дальше: каждый новый `.proto` дописывается во флаги, `go_package` либо засоряет общие схемы, либо ломает генерацию, а breaking всё равно придётся заводить отдельно.

**B.** Дороже на старте: ещё один CLI и два YAML. Дальше дешевле: одна команда на все файлы модуля, managed prefix, и путь к lint/breaking без смены инструмента. Откат — замена рецепта и перегенерация `gen/`, без миграции данных.

**C.** Покупает только «не ставить плагины». Платит сетью в generate, чужим исполнителем схем и пином на BSR. Для Protobuf-in-Git это лишняя зависимость, а не упрощение.

Общее для всех трёх: `gen/` по [contracts/README.md](../../contracts/README.md) не источник правды. `go run` сам его не соберёт — AppHost и Dockerfile вызывают ту же команду, что и CI.

## Предложение

Вариант **B**: `buf generate` с локальными `protoc-gen-go` и `protoc-gen-go-grpc`.

- C отвергается, потому что схемы уходят с машины, а выигрыш — только установка плагинов, которую `go install` и так закрывает.
- A отвергается не потому, что `protoc` хуже генерирует — он генерирует то же самое, — а потому что не закрывает уже названный в integration.md пробел и заставляет писать `go_package` в общих схемах. На объёме первого контракта разница мала; шаблон для следующих Go-сервисов фиксируется сейчас.

Lint и breaking этим RFC не включаются. Legacy-аукцион не проходит `STANDARD`, и чинить его ради Go-кодогена Identity не нужно. Breaking стоит включить отдельной работой вместе с первым контрактом, у которого больше одного потребителя.

Против собственной рекомендации: для двух файлов `protoc` короче, владелец учит ещё один YAML, а главный выигрыш `buf` откладывается. Если владелец хочет минимальный старт, A честен и обратим за один коммит.

## Где зафиксировать результат

По критерию [decisions/README.md](../decisions/README.md) новый ADR не нужен: откат — правка конфигурации и перегенерация. После выбора владельца:

- раздел «Кодогенерация Go» в [protobuf.md](../standards/contracts/protobuf.md) — сюда придёт исполнитель контракта;
- комментарий в индексе ADR-027: выбор закрыт, правило в standard;
- абзац «Стек» в [identity.md](../services/identity.md).

## Открытые вопросы

- владелец выбирает A, B или C;
- breaking в CI — вместе с первым многопотребительским контрактом или позже.

## Результирующие артефакты

- ADR: не нужен;
- standard: раздел в `docs/standards/contracts/protobuf.md` после принятия;
- задачи Linear: рецепт `just identity-proto` и вызов из сборки Identity — в реализации сервиса, не отдельным решением.
