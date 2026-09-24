# Локальная разработка

> **Статус:** Current, частично подтверждено. Профили `infra`, `identity`, `meetups`, `notifications` и срез `hub` без Telegram Bot подтверждены живым прогоном на Aspire 13.5.3 с Docker Desktop; профиль `hub` с Telegram Bot и production-like публикация не проверены.

Граница между local development, production-like integration и production hosting описана в [инфраструктурном обзоре](../architecture/infrastructure.md).

.NET Aspire — принятый и единственный инструмент локальной оркестрации ([ADR-021](../decisions/ADR-021-aspire-local-orchestration.md)). Рукописные `docker-compose.yml` жили внутри сервисов предыдущего поколения и удалены вместе с ними, поэтому fallback-пути больше нет: если `aspire run` не работает, инфраструктура поднимается вручную.

## Требования

- .NET SDK 10;
- Aspire CLI 13.5.3;
- запущенный Docker daemon;
- Go и `buf` для профилей с Identity; `grpcurl` для ручной проверки gRPC-сервисов;
- Node.js, npm и Telegram Bot token для профилей с Telegram Bot; для прогона против тестовой среды — отдельный аккаунт тестового дата-центра и токен тестового бота ([ADR-046](../decisions/ADR-046-telegram-test-contour.md)).

SDK закреплён в корневом `global.json`: базовая версия `10.0.100` и `rollForward: latestFeature` принимают любой установленный SDK линейки .NET 10 — и более новый feature band, и более новый патч. Роняет сборку только SDK ниже 10.0.100: roll forward идёт вверх и никогда вниз, поэтому базовой версией стоит начало линейки, а не та, что оказалась у автора коммита. AppHost таргетит `net10.0`, а все `Aspire.Hosting.*` packages обновляются одной стабильной линией. Текущая линия — 13.5.3.

Там же ключ `test` переводит `dotnet test` на Microsoft.Testing.Platform: на .NET 10 SDK мост в VSTest больше не поддерживается, а xUnit v3 из [норматива](../standards/testing/fsharp.md) идёт только через него. Новый runner принимает решение только флагом `--solution` и не понимает `--nologo` — с ним прогон находит ноль тестов и падает кодом 1.

## AppHost

```powershell
cd infra/apphost
aspire run
```

Для человека `aspire run` остаётся интерактивной командой с dashboard. Агент в worktree использует точный AppHost через `aspire start --non-interactive --isolated --apphost infra/apphost/AppHost.csproj`, ждёт ресурсы через `aspire wait` и штатно останавливает тот же AppHost.

AppHost объявляет граф узлов и их связи, а профиль решает, какими узлами AppHost владеет в этом запуске. Identity разложен на три ресурса: `identity-proto` генерирует Go-код из Protobuf, `identity-build` собирает бинарник в `apps/identity/bin`, и уже готовый бинарник запускает ресурс `identity`, получая динамический gRPC-порт и PostgreSQL URI своей базы `identity` через существующие environment-контракты. Запуск через `go run` не годится: `go run` не пересылает дочернему процессу SIGTERM, которым DCP останавливает ресурс, поэтому graceful shutdown в `main.go` был бы недостижим, а скомпилированный процесс оставался бы жить с занятым портом и открытым пулом PostgreSQL. Готовность проверяется стандартным `grpc.health.v1.Health/Check`, а не только состоянием процесса; у пробы есть deadline вызова и timeout всей проверки, потому что прокси DCP принимает TCP раньше, чем сервер начинает слушать. Meetups устроен проще: это .NET-проект, поэтому отдельных узлов кодогенерации и сборки у него нет — `Grpc.Tools` генерирует C# внутри `dotnet build`, а сборку делает сам Aspire. Сервис слушает h2c и отдаёт готовность той же пробой `grpc.health.v1.Health/Check`, что и Identity: она вынесена в общий хелпер AppHost. В графе он зависит от PostgreSQL: получает `MEETUPS_DATABASE_URL` своей базой `meetups` и применяет свои миграции при старте процесса, а `MEETUPS_COMMUNITY_TIME_ZONE` получает обязательным часовым поясом сообщества — по нему продуктовое чтение отделяет актуальные сходки от архива, а команда назначения момента публикации интерпретирует в этом поясе локальную пару «дата и время», и AppHost локальному прогону отдаёт `Europe/Moscow`. База на сервис — владелец схемы один, чужой сервис её таблиц не видит и именами с ними не сталкивается; сервер PostgreSQL при этом общий. Ресурсы баз названы `identity-db` и `meetups-db`, потому что имена `identity` и `meetups` в пространстве ресурсов Aspire заняты самими сервисами. Формат строки подключения диктует клиент: Go-клиент Identity понимает URI, поэтому получает `UriExpression`, а .NET-у Meetups Aspire отдаёт готовую строку ключей Npgsql через `ConnectionStringExpression` — разбирать URI обратно в ключи не приходится. Смотрящий по-прежнему приходит в запросе. JavaScript integration устанавливает зависимости Telegram Bot, а его `prestart` генерирует TypeScript-контракт и собирает приложение перед запуском. Telegram Bot ждёт здоровые Identity и Meetups, получает их proxy endpoints через `IDENTITY_GRPC_URL` и `MEETUPS_GRPC_URL` и читает `TELEGRAM_BOT_TOKEN` из секретного параметра, который объявляется только когда профиль владеет ботом. Имя этого параметра выбирает среда Telegram, а её значение уходит боту в `TELEGRAM_BOT_ENVIRONMENT`. Пояс сообщества бот получает в `TELEGRAM_BOT_COMMUNITY_TIME_ZONE` тем же значением, что и Meetups: AppHost объявляет его одной константой, потому что карточка показывает момент публикации в том поясе, в котором Meetups его интерпретировал.

## Профили

Профиль — это данные: секция `Topology:Profiles` в `infra/apphost/appsettings.json`. Он перечисляет узлы, которыми AppHost владеет в запуске, и не требует правки кода. Текущий состав:

| Профиль | Инфраструктура | Компоненты |
|---|---|---|
| `infra` | PostgreSQL | нет |
| `identity` | PostgreSQL | Identity |
| `meetups` | PostgreSQL | Meetups |
| `notifications` | PostgreSQL | Notifications |
| `hub` | PostgreSQL | Identity, Meetups, Notifications, Telegram Bot |

Профиль `meetups` поднимает PostgreSQL: сервис применяет миграции при старте и без строки подключения не слушает. Смотрящий по-прежнему приходит в запросе, шины в профиле нет.

Профиль `notifications` устроен так же, но зависимость от базы у него жёстче: в его базе лежат не только доменные таблицы, но и membership силоса Orleans, поэтому без строки подключения сервис не просто не слушает — он не поднимает силос вовсе. Миграции применяет тот же DbUp, и он же заводит таблицы Orleans. Порты силоса штатные и берутся из конфигурации: два профиля с Notifications одновременно на одной машине за них подерутся.

**В рабочем дереве `aspire run` запускают с `--apphost`.** Деревья лежат в `.claude/worktrees/` внутри основного клона, поэтому поиск AppHost вверх по дереву каталогов находит `infra/apphost` родителя, а не свой. Симптом обманчив: запуск падает на `Unknown topology profile` с перечнем профилей основного клона, и выглядит это как ошибка в своей правке `appsettings.json`. Правильная форма — `aspire run --apphost infra/apphost/AppHost.csproj -- --profile <name>`.

Активный профиль задаёт `--profile <name>` или `TOPOLOGY__PROFILE`; первый перекрывает второй. Неизвестное имя профиля, ссылка на незарегистрированный узел и цикл зависимостей отвергаются до построения графа, с перечнем допустимых значений.

```powershell
just aspire infra
```

На старте AppHost печатает баннер топологии: что материализовано и какие объявленные зависимости в этот запуск не попали. Баннер идёт в stdout AppHost, то есть в лог ресурса и в `~/.aspire/logs/`, а не в терминал.

## Тестовая среда Telegram

Профиль отвечает, каким узлом владеет запуск, а среда Telegram — в какой Telegram этот узел ходит. Оси независимы, поэтому профиля на среду не заводится: среда задаётся `--telegram-environment <name>` или ключом `Telegram:Environment` (env `TELEGRAM__ENVIRONMENT`), по умолчанию `prod`. Неизвестное имя останавливает запуск с перечнем допустимых значений — но, в отличие от неизвестного профиля, только там, где среда что-то значит: её читает setup узла, поэтому запуск без бота в профиле значение не смотрит вовсе.

Среда выбирает и имя секретного параметра: `prod` берёт `telegram-bot-token`, `test` — `telegram-bot-test-token`. Запуск спрашивает ровно один токен, поэтому прод- и тестовый живут под разными ключами и не подменяют друг друга. Боту уходит `TELEGRAM_BOT_ENVIRONMENT`, и при `test` вызовы Bot API идут на `https://api.telegram.org/bot<token>/test/`.

Вход в тестовую среду описан [ADR-046](../decisions/ADR-046-telegram-test-contour.md): клиент Telegram переключается на тестовые дата-центры, аккаунт заводится синтетическим номером вида `99966XYYYY`, токен тестового бота выдаёт тестовый BotFather. Токен кладётся в user-secrets AppHost и в репозиторий не попадает. Порядок важен: среда `test` спрашивает другой параметр, и неинтерактивный запуск на отсутствующем `telegram-bot-test-token` падает вместо приглашения ввести значение.

```powershell
dotnet user-secrets --project infra/apphost/AppHost.csproj set "Parameters:telegram-bot-test-token" "<токен тестового бота>"
aspire run --apphost infra/apphost/AppHost.csproj -- --profile hub --telegram-environment test
```

В логе бота строка `telegram-bot starting` несёт поле `telegram_environment`: в какой Telegram ушёл запуск, видно до первого сообщения, а не по отсутствию ответа.

Границы контура заданы тем же решением. Диплинки `t.me/<bot>?start=<payload>` из тестовой среды ведут в продакшн, поэтому сценарий по ссылке проверяется отправкой `/start <payload>` напрямую. Флуд-лимиты тестовой среды строже продакшна, и прогон может упасть по внешней причине: контур принадлежит уровню L3, в `just verify` не входит и ни одного Telegram-секрета не требует.

## Сквозной идентификатор в логах

Telegram Bot создаёт `request_id` на каждый update и передаёт его Identity и Meetups в gRPC-заголовке `x-request-id`. Рядом уходит `use_case` в `x-use-case`: одно действие человека даёт одно и то же значение во всех трёх сервисах. В Aspire dashboard открой **Structured logs**, возьми `request_id` из записи `telegram-bot` и добавь фильтр по точному значению поля `request_id`: один фильтр показывает записи границ всех сервисов, затронутых update. Поиск по тексту сообщения для этого не используется, а backend логов контрактом приложения не является.

Для открытия списка и deep link сходки ожидаются записи `telegram-bot`, Identity и Meetups с одним `request_id` и одним `use_case`. Чистый `/start` без payload вызывает Identity и не ходит в Meetups. Каждый следующий ответ формы создания сходки — новый Telegram update и поэтому новая цепочка со своим `request_id`; `use_case` при этом остаётся сценарием создания. Health checks идут без пользовательского сценария: без `request_id` и без `use_case`.

## Владение вместо режимов

Прежних режимов `Local | Container | Off` нет. AppHost либо владеет узлом и поднимает его, либо не трогает его: имени нет в профиле — компонент запускает владелец, и AppHost не инжектит ему ни адресов, ни строк подключения. Поэтому `just aspire infra` не требует ни Go, ни Node-toolchain, ни Telegram Bot token.

Запуск компонента из Dockerfile вернётся отдельным родом узла, когда у сервиса появится утверждённый Dockerfile.

## Срез внутри профиля

`--run-services` и `--skip-services` меняют состав запуска, не меняя wiring:

```powershell
just aspire hub -- --run-services identity
just aspire hub -- --skip-services telegram-bot
```

Срез не подтягивает соседний сервис из зависимостей: узел вне среза остаётся владельцу. Баннер называет такие зависимости поимённо.

Имена узлов и их связи объявлены в `infra/apphost/Program.cs`, форма кода — в skill `proj-write-aspire-apphost`.

## Проверенный локальный gate

Механика графа, без Docker — эти пункты отрабатывают до старта ресурсов:

1. `dotnet restore` и `dotnet build` для `infra/apphost` успешны.
2. Неизвестный профиль отвергается и через `--profile`, и через `TOPOLOGY__PROFILE`, с перечнем допустимых значений.
3. Профиль, перечисляющий незарегистрированный узел, падает до построения графа.
4. `--run-services telegram-bot` оставляет в запуске только бота, а баннер называет `identity` как объявленную, но не принадлежащую профилю зависимость.
5. Неизвестное имя среды Telegram останавливает запуск профиля с ботом до старта ресурсов: `--profile hub --telegram-environment nope` падает с `Unknown Telegram environment 'nope'` и перечнем допустимых значений.

Живой прогон на Aspire 13.5.3 с Docker Desktop:

6. Профиль `infra` поднимает здоровые PostgreSQL, NATS и базы `identity` и `meetups`, и ни одного компонента.
7. Профиль `identity` завершает `identity-proto` и `identity-build` с кодом 0, поднимает здоровый PostgreSQL и доводит Identity до `Healthy`; NATS в этом профиле не поднимается.
8. Identity запущен собранным бинарником из `apps/identity/bin`, получает `IDENTITY_DATABASE_URL` с `sslmode=disable` и слушает назначенный Aspire порт.
9. `IdentityService/ResolveIdentity` через proxy endpoint Aspire возвращает UUIDv7.
10. После `aspire stop` команда `aspire ps --format Json` возвращает пустой список, и процесса `identity.exe` в системе не остаётся.
11. Профиль `meetups` после PER-58 поднимает здоровые PostgreSQL, `meetups-db` и Meetups. Через назначенный Aspire proxy endpoint `ListVisibleMeetups` со смотрящим отвечает пустым списком на чистой базе, а `GetMeetup` по отсутствующему UUID — `NOT_FOUND`; оба вызова выполнены `grpcurl` без Telegram. Полный интеграционный набор с Docker/Testcontainers проходит 53 теста без пропусков.
12. На зафиксированном до PER-58 прогоне срез `hub` без Telegram Bot (`aspire run -- --skip-services telegram-bot`) держал Identity и Meetups здоровыми одновременно с PostgreSQL, и оба отвечали через свои proxy endpoint. Схемы были разведены по базам одного сервера: goose вёл `identity`, DbUp — `meetups`; на сервере не было базы, которую писали бы оба сервиса.
13. Профиль `notifications` после PER-212 поднимает здоровые PostgreSQL, `notifications-db` и Notifications. В логах сервиса видно применение трёх миграций DbUp — двух вендорных скриптов Orleans и своей схемы — до подъёма силоса, затем `Orleans Silo started.`; проба `grpc.health.v1.Health/Check` отвечает `SERVING` и через назначенный Aspire proxy endpoint, и напрямую, а `aspire describe` показывает узел `Healthy`. После `aspire stop` AppHost останавливается штатно.

## Неподтверждённая граница

После замены заглушек чтения в PER-58 срез `hub` через Aspire ещё нужно повторить с живыми `ListVisibleMeetups` и `GetMeetup`; предыдущий прогон подтверждает только более раннюю совместную топологию Identity и Meetups. Профиль с Telegram Bot ни разу не прогонялся ни с продакшн-токеном, ни с токеном тестовой среды: проверка среды `test` доходит только до отказа графа на неизвестном имени, а `/start` из клиента тестового дата-центра до ответа бота ещё не проходили. Не проверено и повторное подключение тома `solguficky-postgres-data` после перезапуска AppHost. NATS не входит в текущие профили, пока его использование в приложениях не настроено. Пригодность `aspire publish` для production-like k3s и сама production-топология также не проверены. Локальный успешный прогон не является подтверждением deployment-пути.

## Повторная проверка

Механический гейт запускается из корня:

```powershell
just verify
```

Живой gate требует отдельных запусков профилей `infra`, `identity` и `meetups` плюс среза `hub` без Telegram Bot, а после появления токена — и полного `hub`, где первым берётся `--telegram-environment test`, потому что продакшн-токен для живого прогона больше не нужен. Порядок в каждом запуске один: дождаться каждого ожидаемого ресурса через `aspire wait`, сверить граф и health через `aspire describe`, проверить баннер топологии и логи, затем вызвать `IdentityService/ResolveIdentity` и любую операцию `MeetupsService` через найденные в Aspire proxy endpoint и после каждого запуска штатно остановить AppHost. Не используй фиксированный порт: endpoint назначает Aspire.

Работа и её прогресс должны быть заведены в Linear; этот документ хранит только устойчивые правила и проверяемый gap.
