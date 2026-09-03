# Локальная разработка

> **Статус:** Current, частично подтверждено. Механика графа и профилей проверена прогоном на Aspire 13.5.3; живой gate готовности Identity и Telegram Bot после переработки графа не повторялся.

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

AppHost объявляет граф узлов и их связи, а профиль решает, какими узлами AppHost владеет в этом запуске. Identity разложен на три ресурса: `identity-proto` генерирует Go-код из Protobuf, `identity-build` собирает бинарник в `apps/identity/bin`, и уже готовый бинарник запускает ресурс `identity`, получая динамический gRPC-порт и PostgreSQL URI через существующие environment-контракты. Запуск через `go run` не годится: `go run` не пересылает дочернему процессу SIGTERM, которым DCP останавливает ресурс, поэтому graceful shutdown в `main.go` был бы недостижим, а скомпилированный процесс оставался бы жить с занятым портом и открытым пулом PostgreSQL. Готовность проверяется стандартным `grpc.health.v1.Health/Check`, а не только состоянием процесса; у пробы есть deadline вызова и timeout всей проверки, потому что прокси DCP принимает TCP раньше, чем сервер начинает слушать. JavaScript integration устанавливает зависимости Telegram Bot, а его `prestart` генерирует TypeScript-контракт и собирает приложение перед запуском. Telegram Bot ждёт здоровый Identity, получает его proxy endpoint через `IDENTITY_GRPC_URL` и читает `TELEGRAM_BOT_TOKEN` из секретного параметра, который объявляется только когда профиль владеет ботом.

## Профили

Профиль — это данные: секция `Topology:Profiles` в `infra/apphost/appsettings.json`. Он перечисляет узлы, которыми AppHost владеет в запуске, и не требует правки кода. Текущий состав:

| Профиль | Инфраструктура | Компоненты |
|---|---|---|
| `infra` | PostgreSQL, NATS | нет |
| `identity` | PostgreSQL | Identity |
| `core` | PostgreSQL | Identity, Telegram Bot |
| `full` | PostgreSQL, NATS | Identity, Telegram Bot |

Активный профиль задаёт `--profile <name>` или `TOPOLOGY__PROFILE`; первый перекрывает второй. Неизвестное имя профиля, ссылка на незарегистрированный узел и цикл зависимостей отвергаются до построения графа, с перечнем допустимых значений.

```powershell
just aspire infra
```

На старте AppHost печатает баннер топологии: что материализовано и какие объявленные зависимости в этот запуск не попали. Баннер идёт в stdout AppHost, то есть в лог ресурса и в `~/.aspire/logs/`, а не в терминал.

## Владение вместо режимов

Прежних режимов `Local | Container | Off` нет. AppHost либо владеет узлом и поднимает его, либо не трогает его: имени нет в профиле — компонент запускает владелец, и AppHost не инжектит ему ни адресов, ни строк подключения. Поэтому `just aspire infra` не требует ни Go, ни Node-toolchain, ни Telegram Bot token.

Запуск компонента из Dockerfile вернётся отдельным родом узла, когда у сервиса появится утверждённый Dockerfile.

## Срез внутри профиля

`--run-services` и `--skip-services` меняют состав запуска, не меняя wiring:

```powershell
just aspire core -- --run-services identity
just aspire core -- --skip-services telegram-bot
```

Срез не подтягивает соседний сервис из зависимостей: узел вне среза остаётся владельцу. Баннер называет такие зависимости поимённо.

Имена узлов и их связи объявлены в `infra/apphost/Program.cs`, форма кода — в skill `proj-write-aspire-apphost`.

## Проверенный локальный gate

Механика графа подтверждена прогоном после переработки:

1. `dotnet restore` и `dotnet build` для `infra/apphost` успешны.
2. Неизвестный профиль отвергается на старте и через `--profile`, и через `TOPOLOGY__PROFILE`, с перечнем допустимых значений.
3. Профиль, перечисляющий незарегистрированный узел, падает до построения графа.
4. Профиль `infra` материализует PostgreSQL и NATS и ни одного компонента.
5. `--run-services telegram-bot` оставляет в запуске только бота, а баннер называет `identity` как объявленную, но не принадлежащую профилю зависимость.

Все пять пунктов отрабатывают до старта ресурсов, поэтому проверены без Docker: они говорят про граф и баннер, а не про поднятые контейнеры.

Живой gate готовности на прежнем графе выполнялся и проходил, но описывал модель с `go run` и режимами компонентов, которой больше нет. После переработки его нужно повторить целиком:

1. Профиль `identity` завершает `identity-proto` и `identity-build` с кодом 0 и поднимает здоровые PostgreSQL и Identity.
2. Identity применяет миграции, слушает назначенный Aspire порт, отвечает `SERVING` на стандартный gRPC health RPC и успешно выполняет `IdentityService/ResolveIdentity` через proxy endpoint Aspire.
3. Профиль `full` с настоящим Telegram Bot token поднимает бота после здорового Identity.
4. PostgreSQL использует именованный том `solguficky-postgres-data`, который повторно подключается после обычного перезапуска AppHost.
5. После штатной остановки `aspire ps --format Json` не показывает оставшихся сессий, а процесса Identity не остаётся в системе.

## Неподтверждённая граница

Полный профиль с Telegram Bot и настоящим токеном ни разу не прогонялся. Пригодность `aspire publish` для production-like k3s и сама production-топология также не проверены. Локальный успешный прогон не является подтверждением deployment-пути.

## Повторная проверка

Механический гейт запускается из корня:

```powershell
just verify
```

Живой gate требует отдельных запусков профилей `infra`, `identity` и `full`: дождаться каждого ожидаемого ресурса через `aspire wait`, сверить граф и health через `aspire describe`, проверить баннер топологии и логи Identity, затем вызвать `IdentityService/ResolveIdentity` через найденный в Aspire proxy endpoint и после каждого запуска штатно остановить AppHost. Не используй фиксированный порт: endpoint назначает Aspire.

Работа и её прогресс должны быть заведены в Linear; этот документ хранит только устойчивые правила и проверяемый gap.
