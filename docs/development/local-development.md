# Локальная разработка

> **Статус:** Current, частично подтверждено. Профили `infra`, `identity`, `meetups` и срез `core` без Telegram Bot подтверждены живым прогоном на Aspire 13.5.3 с Docker Desktop; профиль с Telegram Bot и production-like публикация не проверены.

Граница между local development, production-like integration и production hosting описана в [инфраструктурном обзоре](../architecture/infrastructure.md).

.NET Aspire — принятый и единственный инструмент локальной оркестрации ([ADR-021](../decisions/ADR-021-aspire-local-orchestration.md)). Рукописные `docker-compose.yml` жили внутри сервисов предыдущего поколения и удалены вместе с ними, поэтому fallback-пути больше нет: если `aspire run` не работает, инфраструктура поднимается вручную.

## Требования

- .NET SDK 10;
- Aspire CLI 13.5.3;
- запущенный Docker daemon;
- Go и `buf` для профилей с Identity; `grpcurl` для ручной проверки gRPC-сервисов;
- Node.js, npm и Telegram Bot token для профилей с Telegram Bot.

SDK закреплён в корневом `global.json`: базовая версия `10.0.100` и `rollForward: latestFeature` принимают любой установленный SDK линейки .NET 10 — и более новый feature band, и более новый патч. Роняет сборку только SDK ниже 10.0.100: roll forward идёт вверх и никогда вниз, поэтому базовой версией стоит начало линейки, а не та, что оказалась у автора коммита. AppHost таргетит `net10.0`, а все `Aspire.Hosting.*` packages обновляются одной стабильной линией. Текущая линия — 13.5.3.

Там же ключ `test` переводит `dotnet test` на Microsoft.Testing.Platform: на .NET 10 SDK мост в VSTest больше не поддерживается, а xUnit v3 из [норматива](../standards/testing/fsharp.md) идёт только через него. Новый runner принимает решение только флагом `--solution` и не понимает `--nologo` — с ним прогон находит ноль тестов и падает кодом 1.

## AppHost

```powershell
cd infra/apphost
aspire run
```

Для человека `aspire run` остаётся интерактивной командой с dashboard. Агент в worktree использует точный AppHost через `aspire start --non-interactive --isolated --apphost infra/apphost/AppHost.csproj`, ждёт ресурсы через `aspire wait` и штатно останавливает тот же AppHost.

AppHost объявляет граф узлов и их связи, а профиль решает, какими узлами AppHost владеет в этом запуске. Identity разложен на три ресурса: `identity-proto` генерирует Go-код из Protobuf, `identity-build` собирает бинарник в `apps/identity/bin`, и уже готовый бинарник запускает ресурс `identity`, получая динамический gRPC-порт и PostgreSQL URI своей базы `identity` через существующие environment-контракты. Запуск через `go run` не годится: `go run` не пересылает дочернему процессу SIGTERM, которым DCP останавливает ресурс, поэтому graceful shutdown в `main.go` был бы недостижим, а скомпилированный процесс оставался бы жить с занятым портом и открытым пулом PostgreSQL. Готовность проверяется стандартным `grpc.health.v1.Health/Check`, а не только состоянием процесса; у пробы есть deadline вызова и timeout всей проверки, потому что прокси DCP принимает TCP раньше, чем сервер начинает слушать. Meetups устроен проще: это .NET-проект, поэтому отдельных узлов кодогенерации и сборки у него нет — `Grpc.Tools` генерирует C# внутри `dotnet build`, а сборку делает сам Aspire. Сервис слушает h2c и отдаёт готовность той же пробой `grpc.health.v1.Health/Check`, что и Identity: она вынесена в общий хелпер AppHost. В графе он зависит от PostgreSQL: получает `MEETUPS_DATABASE_URL` своей базой `meetups` и применяет свои миграции при старте процесса. База на сервис — владелец схемы один, чужой сервис её таблиц не видит и именами с ними не сталкивается; сервер PostgreSQL при этом общий. Ресурсы баз названы `identity-db` и `meetups-db`, потому что имена `identity` и `meetups` в пространстве ресурсов Aspire заняты самими сервисами. Формат строки подключения диктует клиент: Go-клиент Identity понимает URI, поэтому получает `UriExpression`, а .NET-у Meetups Aspire отдаёт готовую строку ключей Npgsql через `ConnectionStringExpression` — разбирать URI обратно в ключи не приходится. Смотрящий по-прежнему приходит в запросе. JavaScript integration устанавливает зависимости Telegram Bot, а его `prestart` генерирует TypeScript-контракт и собирает приложение перед запуском. Telegram Bot ждёт здоровые Identity и Meetups, получает их proxy endpoints через `IDENTITY_GRPC_URL` и `MEETUPS_GRPC_URL` и читает `TELEGRAM_BOT_TOKEN` из секретного параметра, который объявляется только когда профиль владеет ботом.

## Профили

Профиль — это данные: секция `Topology:Profiles` в `infra/apphost/appsettings.json`. Он перечисляет узлы, которыми AppHost владеет в запуске, и не требует правки кода. Текущий состав:

| Профиль | Инфраструктура | Компоненты |
|---|---|---|
| `infra` | PostgreSQL, NATS | нет |
| `identity` | PostgreSQL | Identity |
| `meetups` | PostgreSQL | Meetups |
| `core` | PostgreSQL | Identity, Meetups, Telegram Bot |
| `full` | PostgreSQL, NATS | Identity, Meetups, Telegram Bot |

Профиль `meetups` поднимает PostgreSQL: сервис применяет миграции при старте и без строки подключения не слушает. Смотрящий по-прежнему приходит в запросе, шины в профиле нет.

Активный профиль задаёт `--profile <name>` или `TOPOLOGY__PROFILE`; первый перекрывает второй. Неизвестное имя профиля, ссылка на незарегистрированный узел и цикл зависимостей отвергаются до построения графа, с перечнем допустимых значений.

```powershell
just aspire infra
```

На старте AppHost печатает баннер топологии: что материализовано и какие объявленные зависимости в этот запуск не попали. Баннер идёт в stdout AppHost, то есть в лог ресурса и в `~/.aspire/logs/`, а не в терминал.

## Сквозной идентификатор в логах

Telegram Bot создаёт `request_id` на каждый update и передаёт его Identity и Meetups в gRPC-заголовке `x-request-id`. В Aspire dashboard открой **Structured logs**, возьми `request_id` из записи `telegram-bot` и добавь фильтр по точному значению поля `request_id`: один фильтр показывает записи границ всех сервисов, затронутых update. Поиск по тексту сообщения для этого не используется, а backend логов контрактом приложения не является.

Для `/start` ожидаются записи `telegram-bot`, Identity и Meetups с одним значением. Каждый следующий ответ формы создания сходки — новый Telegram update и поэтому новая цепочка со своим значением; внутри одной цепочки идентификатор не меняется. Health checks идут без пользовательского сценария и без `request_id`.

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

Механика графа, без Docker — эти пункты отрабатывают до старта ресурсов:

1. `dotnet restore` и `dotnet build` для `infra/apphost` успешны.
2. Неизвестный профиль отвергается и через `--profile`, и через `TOPOLOGY__PROFILE`, с перечнем допустимых значений.
3. Профиль, перечисляющий незарегистрированный узел, падает до построения графа.
4. `--run-services telegram-bot` оставляет в запуске только бота, а баннер называет `identity` как объявленную, но не принадлежащую профилю зависимость.

Живой прогон на Aspire 13.5.3 с Docker Desktop:

5. Профиль `infra` поднимает здоровые PostgreSQL, NATS и базы `identity` и `meetups`, и ни одного компонента.
6. Профиль `identity` завершает `identity-proto` и `identity-build` с кодом 0, поднимает здоровый PostgreSQL и доводит Identity до `Healthy`; NATS в этом профиле не поднимается.
7. Identity запущен собранным бинарником из `apps/identity/bin`, получает `IDENTITY_DATABASE_URL` с `sslmode=disable` и слушает назначенный Aspire порт.
8. `IdentityService/ResolveIdentity` через proxy endpoint Aspire возвращает UUIDv7.
9. После `aspire stop` команда `aspire ps --format Json` возвращает пустой список, и процесса `identity.exe` в системе не остаётся.
10. Профиль `meetups` после PER-58 поднимает здоровые PostgreSQL, `meetups-db` и Meetups. Через назначенный Aspire proxy endpoint `ListVisibleMeetups` со смотрящим отвечает пустым списком на чистой базе, а `GetMeetup` по отсутствующему UUID — `NOT_FOUND`; оба вызова выполнены `grpcurl` без Telegram. Полный интеграционный набор с Docker/Testcontainers проходит 53 теста без пропусков.
11. На зафиксированном до PER-58 прогоне срез `core` без Telegram Bot (`aspire run -- --skip-services telegram-bot`) держал Identity и Meetups здоровыми одновременно с PostgreSQL, и оба отвечали через свои proxy endpoint. Схемы были разведены по базам одного сервера: goose вёл `identity`, DbUp — `meetups`; на сервере не было базы, которую писали бы оба сервиса.

## Неподтверждённая граница

После замены заглушек чтения в PER-58 срез `core` через Aspire ещё нужно повторить с живыми `ListVisibleMeetups` и `GetMeetup`; предыдущий прогон подтверждает только более раннюю совместную топологию Identity и Meetups. Профиль с Telegram Bot и настоящим токеном ни разу не прогонялся, как и повторное подключение тома `solguficky-postgres-data` после перезапуска AppHost. Пригодность `aspire publish` для production-like k3s и сама production-топология также не проверены. Локальный успешный прогон не является подтверждением deployment-пути.

## Повторная проверка

Механический гейт запускается из корня:

```powershell
just verify
```

Живой gate требует отдельных запусков профилей `infra`, `identity` и `meetups` плюс среза `core` без Telegram Bot, а после появления токена — и `full`: дождаться каждого ожидаемого ресурса через `aspire wait`, сверить граф и health через `aspire describe`, проверить баннер топологии и логи, затем вызвать `IdentityService/ResolveIdentity` и любую операцию `MeetupsService` через найденные в Aspire proxy endpoint и после каждого запуска штатно остановить AppHost. Не используй фиксированный порт: endpoint назначает Aspire.

Работа и её прогресс должны быть заведены в Linear; этот документ хранит только устойчивые правила и проверяемый gap.
