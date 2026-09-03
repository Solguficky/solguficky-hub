# Локальная разработка

> **Статус:** Current, частично подтверждено. Профиль `infra` и Identity-срез проверены живым прогоном на Aspire 13.5.3 с Docker Desktop; полный профиль с Telegram Bot и production-like публикация пока не проверены.

Граница между local development, production-like integration и production hosting описана в [инфраструктурном обзоре](../architecture/infrastructure.md).

.NET Aspire — принятый и единственный инструмент локальной оркестрации ([ADR-021](../decisions/ADR-021-aspire-local-orchestration.md)). Рукописные `docker-compose.yml` жили внутри сервисов предыдущего поколения и удалены вместе с ними, поэтому fallback-пути больше нет: если `aspire run` не работает, инфраструктура поднимается вручную.

## Требования

- .NET SDK 10;
- Aspire CLI 13.5.3;
- запущенный Docker daemon;
- Go и `buf` для профилей с Identity;
- Node.js, npm и Telegram Bot token для профилей с Telegram Bot.

AppHost остаётся на `net8.0`, а SDK и все `Aspire.Hosting.*` packages обновляются одной стабильной линией. Текущая линия — 13.5.3.

## AppHost

```powershell
cd infra/apphost
aspire run
```

Для человека `aspire run` остаётся интерактивной командой с dashboard. Агент в worktree использует точный AppHost через `aspire start --non-interactive --isolated --apphost infra/apphost/AppHost.csproj`, ждёт ресурсы через `aspire wait` и штатно останавливает тот же AppHost.

AppHost всегда объявляет PostgreSQL 16 и NATS 2.10 с JetStream. Профили `core` и `full` также поднимают Identity и Telegram Bot из исходников. Identity разложен на три ресурса: `identity-proto` генерирует Go-код из Protobuf, `identity-build` собирает бинарник в `apps/identity/bin`, и уже готовый бинарник запускает ресурс `identity`, получая динамический gRPC-порт и PostgreSQL URI через существующие environment-контракты. Запуск через `go run` не годится: `go run` не пересылает дочернему процессу SIGTERM, которым DCP останавливает ресурс, поэтому graceful shutdown в `main.go` был бы недостижим, а скомпилированный процесс оставался бы жить с занятым портом и открытым пулом PostgreSQL. Готовность проверяется стандартным `grpc.health.v1.Health/Check`, а не только состоянием процесса; у пробы есть deadline вызова и timeout всей проверки, потому что прокси DCP принимает TCP раньше, чем сервер начинает слушать. JavaScript integration устанавливает зависимости Telegram Bot, а его `prestart` генерирует TypeScript-контракт и собирает приложение перед запуском. Telegram Bot ждёт здоровый Identity, получает его proxy endpoint через `IDENTITY_GRPC_URL` и читает `TELEGRAM_BOT_TOKEN`. Секретный параметр `telegram-bot-token` объявляется только в режиме `TelegramBot=Local`, поэтому профиль `infra` не требует ни token, ни toolchain компонентов.

## Профили

| Профиль | Компоненты |
|---|---|
| `infra` | PostgreSQL + NATS; компоненты платформы выключены |
| `core` | infra + Identity + Telegram Bot в режиме `Local` |
| `full` | infra + все зарегистрированные компоненты в режиме `Local`; сейчас это Identity и Telegram Bot |

`just aspire infra` не собирает Telegram Bot. Неизвестное имя профиля отвергается на старте с перечнем допустимых значений.

```powershell
$env:TOPOLOGY__PROFILE='infra'
aspire run
```

## Режим компонента

Допустимы `Local` (из исходников), `Container` (через Dockerfile) и `Off` (владелец запускает сам):

```powershell
$env:TOPOLOGY__IDENTITY='Off'
aspire run
```

`Identity=Local` запускает сервис из исходников. `Identity=Off` оставляет его владельцу. `Identity=Container` сейчас намеренно завершается понятной ошибкой: у сервиса ещё нет утверждённого Dockerfile. Неизвестное значение режима также отвергается на старте.

Те же правила действуют для `TelegramBot`: режим `Local` запускает приложение из исходников, `Off` выключает его, а `Container` пока не поддержан. Неизвестное значение режима отвергается до построения графа.

Имена компонентов появляются в `infra/apphost/Program.cs` вместе с их регистрацией; состав первого среза — в `Topology.CoreComponents`.

## Проверенный локальный gate

1. `dotnet restore` и `dotnet build` для `infra/apphost` успешны.
2. Профиль `infra` поднимает здоровые PostgreSQL и NATS без Identity.
3. Профиль `full` с `TOPOLOGY__TELEGRAMBOT=Off` завершает `identity-proto` и `identity-build` с кодом 0 и поднимает здоровые PostgreSQL, NATS и Identity.
4. Identity применяет миграции, слушает назначенный Aspire порт, отвечает `SERVING` на стандартный gRPC health RPC и успешно выполняет `IdentityService/ResolveIdentity` через proxy endpoint Aspire.
5. Неизвестный профиль, неизвестный режим и неподдерживаемый `Identity=Container` завершают AppHost с понятной ошибкой.
6. PostgreSQL использует именованный том `solguficky-postgres-data`, который повторно подключается после обычного перезапуска AppHost.
7. После штатной остановки `aspire ps --format Json` не показывает оставшихся сессий, а процесса Identity не остаётся в системе.

Прогон выполнялся на графе, где Identity запускался через `go run`. Пункты 3, 4 и 7 после перевода на собранный бинарник и на пробу с deadline нужно повторить: сам факт, что `go run` не доставляет дочернему процессу SIGTERM и оставляет его сиротой, проверен отдельно на минимальной программе, но не в графе Aspire.

## Неподтверждённая граница

Полный профиль с Telegram Bot и настоящим токеном после объединения графов ещё не прогонялся. Пригодность `aspire publish` для production-like k3s и сама production-топология также не проверены. Локальный успешный прогон не является подтверждением deployment-пути.

## Повторная проверка

Механический гейт запускается из корня:

```powershell
just verify
```

Живой gate Identity требует отдельного запуска профилей `infra` и `full` с `TOPOLOGY__TELEGRAMBOT=Off`: дождаться каждого ожидаемого ресурса через `aspire wait`, сверить граф и health через `aspire describe`, проверить логи Identity, затем вызвать `IdentityService/ResolveIdentity` через найденный в Aspire proxy endpoint и после каждого запуска штатно остановить AppHost. Полный gate дополнительно запускает `full` с настоящим Telegram Bot token и проверяет, что бот стартует после здорового Identity. Не используй фиксированный порт: endpoint назначает Aspire.

Работа и её прогресс должны быть заведены в Linear; этот документ хранит только устойчивые правила и проверяемый gap.
