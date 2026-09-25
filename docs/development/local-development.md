# Локальная разработка

> **Статус:** Current, частично подтверждено. Этот документ — единственный владелец факта о том, что подтверждено живым прогоном Aspire; остальные документы на него ссылаются и своего перечня не держат. Профили `infra`, `identity`, `meetups`, `notifications`, срез `hub` без Telegram Bot вместе с NATS и его повтор на том же томе подтверждены живым прогоном на Aspire 13.5.3 с Docker Desktop, полный `hub` с Telegram Bot и сценарий первого среза, кроме сквозной цепочки `request_id`, — в продакшн-среде Telegram отдельным локальным ботом; тестовая среда Telegram и production-like публикация не проверены.

Граница между local development, production-like integration и production hosting описана в [инфраструктурном обзоре](../architecture/infrastructure.md).

.NET Aspire — принятый и единственный инструмент локальной оркестрации ([ADR-021](../decisions/ADR-021-aspire-local-orchestration.md)). Рукописные `docker-compose.yml` жили внутри сервисов предыдущего поколения и удалены вместе с ними, поэтому fallback-пути больше нет: если `aspire run` не работает, инфраструктура поднимается вручную.

## Требования

- .NET SDK 10;
- Aspire CLI 13.5.3;
- запущенный Docker daemon;
- Go и `buf` для профилей с Identity; `grpcurl` для ручной проверки gRPC-сервисов;
- JDK версии из `apps/auction/.java-version`, sbt и `just` в PATH для профиля `auction`: `java` из PATH запускает сервис, и его версия обязана совпадать с той, под которую собран код;
- Node.js, npm и Telegram Bot token для профилей с Telegram Bot; для прогона против тестовой среды — отдельный аккаунт тестового дата-центра и токен тестового бота ([ADR-046](../decisions/ADR-046-telegram-test-contour.md)).

SDK закреплён в корневом `global.json`: базовая версия `10.0.100` и `rollForward: latestFeature` принимают любой установленный SDK линейки .NET 10 — и более новый feature band, и более новый патч. Роняет сборку только SDK ниже 10.0.100: roll forward идёт вверх и никогда вниз, поэтому базовой версией стоит начало линейки, а не та, что оказалась у автора коммита. AppHost таргетит `net10.0`, а все `Aspire.Hosting.*` packages обновляются одной стабильной линией. Текущая линия — 13.5.3.

Там же ключ `test` переводит `dotnet test` на Microsoft.Testing.Platform: на .NET 10 SDK мост в VSTest больше не поддерживается, а xUnit v3 из [норматива](../standards/testing/fsharp.md) идёт только через него. Новый runner принимает решение только флагом `--solution` и не понимает `--nologo` — с ним прогон находит ноль тестов и падает кодом 1.

## AppHost

```powershell
cd infra/apphost
aspire run
```

Для человека `aspire run` остаётся интерактивной командой с dashboard. Агент в worktree использует точный AppHost через `aspire start --non-interactive --isolated --apphost infra/apphost/AppHost.csproj`, ждёт ресурсы через `aspire wait` и штатно останавливает тот же AppHost.

AppHost объявляет граф узлов и их связи, а профиль решает, какими узлами AppHost владеет в этом запуске. Identity разложен на три ресурса: `identity-proto` генерирует Go-код из Protobuf, `identity-build` собирает бинарник в `apps/identity/bin`, и уже готовый бинарник запускает ресурс `identity`, получая динамический gRPC-порт и PostgreSQL URI своей базы `identity` через существующие environment-контракты. Запуск через `go run` не годится: `go run` не пересылает дочернему процессу SIGTERM, которым DCP останавливает ресурс, поэтому graceful shutdown в `main.go` был бы недостижим, а скомпилированный процесс оставался бы жить с занятым портом и открытым пулом PostgreSQL. Готовность проверяется стандартным `grpc.health.v1.Health/Check`, а не только состоянием процесса; у пробы есть deadline вызова и timeout всей проверки, потому что прокси DCP принимает TCP раньше, чем сервер начинает слушать. Meetups устроен проще: это .NET-проект, поэтому отдельных узлов кодогенерации и сборки у него нет — `Grpc.Tools` генерирует C# внутри `dotnet build`, а сборку делает сам Aspire. Сервис слушает h2c и отдаёт готовность той же пробой `grpc.health.v1.Health/Check`, что и Identity: она вынесена в общий хелпер AppHost. В графе он зависит от PostgreSQL: получает `MEETUPS_DATABASE_URL` своей базой `meetups` и применяет свои миграции при старте процесса, а `MEETUPS_COMMUNITY_TIME_ZONE` получает обязательным часовым поясом сообщества — по нему продуктовое чтение отделяет актуальные сходки от архива, а команда назначения момента публикации интерпретирует в этом поясе локальную пару «дата и время», и AppHost локальному прогону отдаёт `Europe/Moscow`. База на сервис — владелец схемы один, чужой сервис её таблиц не видит и именами с ними не сталкивается; сервер PostgreSQL при этом общий. Ресурсы баз названы `identity-db` и `meetups-db`, потому что имена `identity` и `meetups` в пространстве ресурсов Aspire заняты самими сервисами. Формат строки подключения диктует клиент: Go-клиент Identity понимает URI, поэтому получает `UriExpression`, а .NET-у Meetups Aspire отдаёт готовую строку ключей Npgsql через `ConnectionStringExpression` — разбирать URI обратно в ключи не приходится. Смотрящий по-прежнему приходит в запросе. JavaScript integration устанавливает зависимости Telegram Bot, а его `prestart` генерирует TypeScript-контракт и собирает приложение перед запуском. Telegram Bot ждёт здоровые Identity и Meetups, получает их proxy endpoints через `IDENTITY_GRPC_URL` и `MEETUPS_GRPC_URL` и читает `TELEGRAM_BOT_TOKEN` из секретного параметра, который объявляется только когда профиль владеет ботом. Имя этого параметра выбирает среда Telegram, а её значение уходит боту в `TELEGRAM_BOT_ENVIRONMENT`. Пояс сообщества бот получает в `TELEGRAM_BOT_COMMUNITY_TIME_ZONE` тем же значением, что и Meetups: AppHost объявляет его одной константой, потому что карточка показывает момент публикации в том поясе, в котором Meetups его интерпретировал. Auction разложен так же, как Identity, и по той же причине: `sbt run` форкает JVM, а форкнутая JVM переживает sbt, которого остановил DCP. Поэтому `auction-build` рецептом `just auction-classpath` компилирует сервис и пишет его runtime classpath в `apps/auction/target/aspire-classpath`, а ресурс `auction` запускает `java auction.Main`, получая classpath переменной `CLASSPATH`, порт — через `AUCTION_HTTP_PORT` и готовность — по `GET /health`. База `auction` отдаётся в форме Pekko Persistence JDBC: URL `AUCTION_DATABASE_JDBC_URL` без учётных данных и отдельно `AUCTION_DATABASE_USER` и `AUCTION_DATABASE_PASSWORD`; читать их сервис начнёт вместе с журналом ([PER-302](https://linear.app/anticnvm/issue/per-302)). В `hub` Auction не входит: аукцион не часть MVP, и `hub` не должен требовать JDK.

## Профили

Профиль — это данные: секция `Topology:Profiles` в `infra/apphost/appsettings.json`. Он перечисляет узлы, которыми AppHost владеет в запуске, и не требует правки кода. Текущий состав:

| Профиль | Инфраструктура | Компоненты |
|---|---|---|
| `infra` | PostgreSQL, NATS | нет |
| `identity` | PostgreSQL | Identity |
| `meetups` | PostgreSQL | Meetups |
| `notifications` | PostgreSQL, NATS | Notifications |
| `notifications-observability` | PostgreSQL, NATS, Loki, Grafana | Notifications |
| `auction` | PostgreSQL | Auction |
| `hub` | PostgreSQL, NATS | Identity, Meetups, Notifications, Telegram Bot |

Список `Infrastructure` — это backing stores того контура, который профиль изображает: `infra` показывает инфраструктуру платформы без компонентов, профиль одного сервиса — только те хранилища, которые связывает этот сервис, `hub` — полный локальный контур платформы. Поэтому NATS стоит в `infra`, `hub` и обоих профилях Notifications — единственного сервиса, который шину читает: он собирает из неё реплику чужих фактов ([PER-215](https://linear.app/anticnvm/issue/per-215)) и без адреса шины не стартует. В профилях `identity` и `meetups` его нет: они шину не читают, и в одиночном прогоне контейнер был бы мёртвым грузом. Loki и Grafana — не backing store платформы, а инструмент разбора одного сервиса, поэтому ими владеет только `notifications-observability`, и в `infra` и `hub` их нет.

Потребитель шины среди сервисов один — Notifications: `depends` называет `nats`, а bind отдаёт адрес переменной `NOTIFICATIONS_NATS_URL` и ждёт узел. Producer среди сервисов тоже один — Meetups: `nats` стоит в его `depends`, адрес приходит в `MEETUPS_NATS_URL`, и `WaitFor` внутри bind ждёт не только здоровья брокера, но и применения топологии JetStream, поэтому первая публикация не встречает отсутствующий стрим ([PER-209](https://linear.app/anticnvm/issue/per-209)); публикацию Identity приносит [PER-210](https://linear.app/anticnvm/issue/per-210). Прогон профиля `meetups` 2026-09-25 подтвердил публикацию: Meetups дошёл до `Healthy` с адресом шины из bind, миграция `009` применилась на томе с накопленным журналом, первый тик опубликовал весь бэклог из 33 событий без единого отказа, а черновик, созданный `CreateMeetupDraft` с заголовком `x-request-id`, ушёл следующим тиком с тем же `request_id`. Путь «Meetups → шина → реплика Notifications» одним живым прогоном ещё не подтверждён: прогон ниже доказывает путь от шины до реплики. Прогон профиля `notifications` 2026-09-25 подтвердил: сервис дождался применения топологии и привязался к обоим durable, событие `meetup_published`, опубликованное `nats-tester`, применилось к реплике с исходом `applied`, а то же событие под другим `Nats-Msg-Id` пришло как `duplicate`. Сообщения, оставленные на томе `solguficky-nats-data` прежними ручными проверками без `state`, сервис снял с доставки как нарушающие контракт, и поток после них не встал. В `infra` потребитель есть уже сегодня, но это не сервис, а `tools/nats-tester`.

Зарегистрированный узел обязан быть назван хотя бы одним профилем: узел без владельца не материализуется ни в одном запуске, и симптома у этого нет — сборка зелёная, запуск успешный, ресурса просто нет. Поэтому `ServiceGraph.Validate()` отвергает такой граф до старта ресурсов, и регистрация узла едет одним изменением с профилем, который им владеет.

Профиль `meetups` поднимает PostgreSQL и NATS: сервис применяет миграции при старте и без строки подключения не слушает, а события журнала публикует в `MEETUPS_EVENTS`. Смотрящий по-прежнему приходит в запросе. Запуск Meetups без узла `nats` — срезом или своим профилем — оставляет порт публикации ненастроенным: события копятся в журнале pending и уходят, когда сервис стартует с адресом шины. Том PostgreSQL, собранный до миграции `009`, пересоздавать не нужно: она заполняет `material_id` старых событий материалов из их же истории.

Профиль `notifications` устроен так же, но зависимость от базы у него жёстче: в его базе лежат не только доменные таблицы, но и membership силоса Orleans, поэтому без строки подключения сервис не просто не слушает — он не поднимает силос вовсе. Миграции применяет тот же DbUp, и он же заводит таблицы Orleans. Шина для него обязательна так же, как база: без `NOTIFICATIONS_NATS_URL` процесс завершается с кодом 1, а без своих durable — останавливается после старта. Порты силоса штатные и берутся из конфигурации: два профиля с Notifications одновременно на одной машине за них подерутся.

Узел `nats` поднимается образом `nats:2.10-alpine` с включённым JetStream и защищён паролем из параметра `nats-password`. Две вещи ломают ожидания и стоят отдельной строки. Порт клиента назначает Aspire, а не 4222: `tools/nats-tester` по умолчанию идёт в `nats://localhost:4222`, поэтому адрес и учётные данные берутся из дашборда и передаются флагом `--nats-url`. JetStream держит store на томе `solguficky-nats-data`, поэтому стримы, сообщения и позиции durable переживают перезапуск AppHost. Streams и durable consumers создаёт сам AppHost, когда узел готов: состав — в [каталоге интеграций](../architecture/integration.md#jetstream), лог узла `nats` пишет `JetStream topology applied` с перечнем имён. Применение идемпотентно, но правку, которую JetStream на живом объекте не принимает, — storage стрима, переход retention в `workqueue` или из него, deliver policy durable (проверено на nats-server 2.10.29; `limits` ↔ `interest` сервер принимает) — сервер отвергает, и лог узла пишет `JetStream topology was not applied`. Узел при этом остаётся `Healthy`, но Notifications его ждёт, и ожидание падает вместе с применением: в профиле с Notifications сломанная топология видна по не стартовавшему сервису, в `infra` — только по логу узла. Лечится удалением тома `solguficky-nats-data`, а с ним и всех сообщений шины. Имя тома одно на машину, как у PostgreSQL: два одновременных запуска с NATS из разных деревьев или вместе с `just contour-test` пишут в один store, а последовательные наследуют сообщения и позиции durable друг друга.

`notifications-observability` — отдельный локальный профиль для разбора молчащего reminder'а: Aspire поднимает Loki 3.7.0 и Grafana 13.1.6 вместе с Notifications, а сервис отправляет логи одновременно в Aspire Dashboard и Loki через OTLP/HTTP. Обычные профили этих контейнеров не поднимают. Адрес Grafana выдаёт Aspire (`aspire describe --format Json`), панель **Notifications reminders** и источник Loki загружаются автоматически из `infra/observability/`. Для агента в рабочем дереве:

```powershell
aspire start --isolated --non-interactive --apphost infra/apphost/AppHost.csproj -- --profile notifications-observability
aspire wait notifications --apphost infra/apphost/AppHost.csproj --non-interactive
aspire wait grafana --apphost infra/apphost/AppHost.csproj --non-interactive
aspire stop --apphost infra/apphost/AppHost.csproj --non-interactive
```

Встроенный вход Grafana для локального контейнера — `admin/admin`; профиль не предназначен для публикации в сеть. Запросы и толкование признаков описаны в [Notifications](../services/notifications.md#как-заметить-молчащее-напоминание). Остановленный сервис не выдаёт heartbeat; пустую панель при самом первом запуске следует отличать от здорового нуля после первого тика.

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

Все три сервиса отправляют логи в dashboard по OTLP и пишут успешную запись границы на `info`, то есть она видна при уровне по умолчанию. Meetups получает OTLP-переменные от AppHost как проект .NET, бот — от `AddJavaScriptApp`, Identity — явным `WithOtlpExporter()` в его setup. Консольный JSON остаётся у Identity и бота рядом с OTLP: Structured logs его не разбирает, фильтр по полю работает только на записях, пришедших по OTLP. Успешную пробу здоровья Identity пишет на `debug`, Meetups не пишет вовсе, поэтому при уровне по умолчанию пробы Structured logs не засоряют. Подтверждено прогоном PER-351 (ниже).

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
6. Зарегистрированный узел, которого не назвал ни один профиль, роняет запуск до старта ресурсов. Проверено удалением `nats` из обоих профилей: `Node 'nats' is registered in the graph, but no profile owns it, so it is never materialized`.

Каждый пункт ниже — наблюдение одного прогона, а не свойство системы вообще: он говорит, что названная команда в названной среде дала названный результат, и не обещает того же для профиля, которого в пункте нет. Среда всех прогонов PER-228: Aspire CLI 13.5.3, .NET SDK 10, Docker 28.5.1, Windows 11.

Прогон PER-228 от 2026-09-22 — профили с NATS, полный состав без бота, срез и повтор:

7. Профиль `infra` поднимает здоровые PostgreSQL, три базы (`identity-db`, `meetups-db`, `notifications-db`) и NATS, и ни одного компонента. JetStream включён фактически, а не только в коде: в логе контейнера видно `Starting JetStream` и баннер JETSTREAM у nats-server 2.10.29. Своей пробы шине не добавляли — узел доходит до `Healthy` встроенной пробой `AddNats`.
8. Профиль `hub` со срезом `--skip-services telegram-bot` поднимает за один заход PostgreSQL, NATS, три базы и три компонента: `identity-proto` и `identity-build` завершаются кодом 0, а `identity`, `meetups` и `notifications` доходят до `Healthy`. Баннер топологии называет `nats` и `postgres` владением профиля.
9. Миграции применяются при старте у всех трёх сервисов и до того, как сервис начинает слушать: Identity пишет `migrations applied` перед `identity listening`, DbUp Meetups и Notifications выполняет свои скрипты, и у Notifications за ними идёт подъём силоса Orleans.
10. Повторный запуск того же среза на сохранившемся томе `solguficky-postgres-data` ничего не ломает: DbUp обоих .NET-сервисов отвечает `No new scripts need to be executed`, все узлы снова `Healthy`. Этим же подтверждено переподключение тома после перезапуска AppHost.
11. Живые пути чтения отвечают через назначенные Aspire proxy endpoint, вызовы сделаны `grpcurl` без Telegram: `IdentityService/ResolveIdentity` возвращает UUIDv7, `ListVisibleMeetups` со смотрящим — пустой список, `GetMeetup` по отсутствующему UUID — `NOT_FOUND`, проба Notifications `grpc.health.v1.Health/Check` — `SERVING`.
12. Срез по одному сервису поднимается по-прежнему: `--profile hub --run-services identity` оставляет среди компонентов только Identity. Инфраструктуру срез не режет, поэтому NATS поднимается и в нём — это цена владения шиной в профиле `hub`, а не сбой.
13. После `aspire stop` команда `aspire ps --format Json` возвращает пустой список, контейнеров `postgres` и `nats` в системе не остаётся.

Прогон PER-228 от 2026-09-24 — полный `hub` с Telegram Bot, после слияния с `develop`:

14. Профиль `hub` без среза поднимает за один заход PostgreSQL, три базы, NATS и все четыре компонента: `identity`, `meetups` и `notifications` доходят до `Healthy`, `telegram-bot` — до `Running`, узлы сборки и установки завершаются. Бот пишет `telegram-bot starting` с `telegram_environment: prod` и `long polling started`, ни `401`, ни `409 Conflict` в логе нет.
15. `/start` от владельца доходит до бота и дальше: апдейт приходит через long polling, бот разрешает отправителя через Identity в новую личность и получает отказ проверки допуска `hub_access_pending` — ожидаемый исход для нового человека на чистой базе, допуск выдаёт администратор. Отправку ответа бот в лог не пишет, поэтому этот пункт подтверждает путь от Telegram до Identity, а не отрисовку ответа.

Запуск шёл в продакшн-среде Telegram, но **не токеном бота сообщества**: под `Parameters:telegram-bot-token` на машине владельца лежит токен отдельного локального бота, созданного для разработки. Поэтому второго polling-экземпляра у бота сообщества не появилось, а писать такому боту некому, кроме самого разработчика. Это не тестовый контур [ADR-046](../decisions/ADR-046-telegram-test-contour.md): аккаунты в продакшн-среде настоящие.

Прогон PER-208 от 2026-09-24 — топология JetStream, профиль `infra`, проверка `tools/nats-tester`:

16. На старте узла `nats` AppHost создаёт стримы `MEETUPS_EVENTS` и `IDENTITY_EVENTS` и четыре durable, лог пишет `JetStream topology applied`. Store лежит в `/var/lib/nats/jetstream` на томе, а не во временном каталоге. `nats-tester streams` показывает retention `limits`, storage `file`, `max_age` 7 дней и окно дедупликации 2 минуты.
17. Четыре публикации дают три сообщения в стриме: второй `publish` того же события с `Nats-Msg-Id = event_id` сервер отбрасывает. Повтор с `--no-msg-id` доходит до потребителя, и `nats-tester consume` помечает его `DUPLICATE` по `event_id`.
18. Событие, опубликованное, пока потребитель выключен, приходит на следующем `consume` одно: уже подтверждённые не перечитываются. Durable `notifications-meetups-events`, у которого потребителя ещё нет, копит их как `pending`.
19. После `aspire stop` и повторного старта на том же томе стрим сохраняет сообщения, durable — позицию подтверждения, а повторное применение топологии проходит без ошибок.

Прогон PER-174 от 2026-09-24–25 — [кадры ошибок](../architecture/first-slice.md#ошибки-и-degraded-behavior) на полном `hub` с тем же локальным ботом, клиент Telegram вёл владелец. Среда та же, что у PER-228: Aspire CLI 13.5.3, Docker 28.5.1, Windows 11.

20. Ответ бота отрисовывается в клиенте: после выдачи ролей `admin` и `member` служебными RPC Identity `/start` открывает главный экран, форма создания доходит до карточки предпросмотра и публикации. Этим закрыт пробел пункта 15.
21. Остановка Meetups и Identity командой `aspire resource <имя> stop` даёт fail-closed: при остановленном Meetups список и карточка отвечают кадром сбоя, а не пустым списком; при остановленном Identity ни один `request_id` не доходит до Meetups, и журнал событий сходки не растёт. Двойное нажатие «Опубликовать» при работающих сервисах оставляет одно событие `meetup_published`. После `aspire resource <имя> start` бот без перезапуска снова работает с обоими по прежним адресам.
22. Два чтения, пришедшие в proxy endpoint остановленного Meetups, исполнились после старта процесса, хотя бот уже ответил по ним таймаутом. Команду в таком окне не наблюдали; если она ведёт себя так же, это исполнение после отказа клиенту.

Разбор каждого кадра и заведённые по расхождениям задачи — в комментарии к [PER-174](https://linear.app/anticnvm/issue/per-174).

Прогон PER-5 от 2026-09-25 — [сценарий первого среза](../architecture/first-slice.md#сценарий) целиком на полном `hub` с тем же локальным ботом; Telegram-клиент вёл владелец с двух аккаунтов, администратора и солегуфика. Среда та же, что у PER-228.

23. Юзкейс проходит без Telegram: сценарий `grpcurl` через reflection и proxy endpoint выдаёт роли служебными RPC Identity, заводит черновик, публикует сходку и открывает её от лица `member` — 12 проверок из 12. Повтор `CreateMeetupDraft` с тем же id и повтор `PublishMeetup` возвращают прежнюю версию, в журнале сходки одно `meetup_created` и одно `meetup_published`. Сценарий приложен к [PER-5](https://linear.app/anticnvm/issue/per-5).
24. Отрицательная половина держится и через `grpcurl`, и через бота. До публикации `GetMeetup` от лица `member` отвечает `NotFound`, побайтово совпадающим с ответом на несуществующий id, а `ListVisibleMeetups` черновика не содержит. В клиенте `/start m_<токен>` скрытой и несуществующей сходки дают одинаковое «Сходка не найдена или больше недоступна». Настоящая причина остаётся в логе Meetups: `visibility` / `not_visible` у скрытой, `invariant` / `missing` у несуществующей. Payload — `m_` и 22 символа base64url, а не сырой UUID: `/start m_<uuid>` бот принимает за обычный `/start`.
25. Новый профиль с ником из whitelist получает `member` на первом `/start`, и солегуфик сразу видит список. Это отступление от предусловия сценария: без роли бот отвечает `hub_access_pending` (пункт 15), поэтому пустой список P-02 солегуфиком без профиля в этом прогоне не наблюдался ([PER-352](https://linear.app/anticnvm/issue/per-352)). После публикации сходка появляется в его списке, карточка открывается и кнопкой, и прямой ссылкой.
26. Опубликованная сходка переживает `aspire resource <имя> restart` для Identity и Meetups, а затем `aspire stop` и новый `aspire start` на том же томе: состояние и версия прежние, строка одна, в списке солегуфика она один раз. Брошенная на вопросе о дате форма после рестарта бота отвечает «вопрос устарел», как и задумано [ADR-030](../decisions/ADR-030-telegram-bot.md). Сам черновик в Meetups цел, но из интерфейса недостижим: «Управление сходками» предлагает только создать новую ([PER-353](https://linear.app/anticnvm/issue/per-353)).
27. Цепочка одного `request_id` собирается не во всех трёх сервисах. Для deep link на скрытую сходку фильтр в Structured logs находит одну запись Meetups; в консольном логе запись есть у бота — отказ пишется на `warn` — и нет у Identity, чей вызов прошёл успешно. Identity и бот в Structured logs не попадают вовсе, а успешную запись границы пишут на `debug`, поэтому на успешном пути в консоли при уровне по умолчанию нет записи ни того, ни другого. Раздел «Сквозной идентификатор в логах» выше этим прогоном не подтверждён; закрыто прогоном [PER-351](https://linear.app/anticnvm/issue/per-351) ниже.
28. Посреди прогона PostgreSQL ушёл в immediate shutdown с тем же признаком, что в PER-174: `could not open file "postmaster.pid"` и `data directory lock file is invalid`. Сам второй запуск на общем томе не наблюдался — к моменту разбора его уже не было. Aspire контейнер сам не поднял — помогли `aspire resource postgres start` и рестарт зависимых сервисов; данные уцелели ([PER-340](https://linear.app/anticnvm/issue/per-340)).

Разбор и заведённые по расхождениям задачи — в комментарии к [PER-5](https://linear.app/anticnvm/issue/per-5).

Прогон PER-351 от 2026-09-25 — полный `hub` с тем же локальным ботом. Открытие карточки опубликованной сходки через `/start m_<токен>` дало в Structured logs три записи уровня `Information` — `telegram-bot`, `identity` и `meetups` — с одним атрибутом `request_id` и `use_case` = `view_meetup`; поиск по значению поля нашёл все три. Первая попытка до Meetups не дошла: PostgreSQL ответил Identity `cache lookup failed for function`, а через пять секунд ушёл в immediate shutdown с признаком из пункта 28. Помогли `aspire resource postgres start` и рестарт зависимых сервисов, как и там ([PER-340](https://linear.app/anticnvm/issue/per-340)).

Прогон PER-290 от 2026-09-25 — профиль `auction`, агентский lifecycle (`aspire start --isolated`, `aspire wait`, `aspire stop`). Среда та же, что у PER-228, плюс JDK 25 и sbt из `apps/auction/.java-version` и `project/build.properties`.

29. Профиль `auction` поднимает PostgreSQL, пустую базу `auction-db` и Auction: `auction-build` завершается кодом 0, `auction` доходит до `Healthy` за 58 секунд на холодном sbt. Баннер топологии называет `postgres` и `auction` как принадлежащие профилю. Сервис запущен процессом `java auction.Main`, а не `sbt run`, и получает `AUCTION_HTTP_PORT`, `AUCTION_DATABASE_JDBC_URL` вида `jdbc:postgresql://localhost:<порт>/auction`, `AUCTION_DATABASE_USER` и `AUCTION_DATABASE_PASSWORD`; ключи базы сервис пока не читает.
30. `GET /health` через proxy endpoint из `aspire describe` отвечает `200` с `{"status":"ok"}`, и граница пишет запись операции `GET /health` с исходом `ok`.
31. После `aspire stop` процесса `java` с `auction.Main` в системе не остаётся, и target-порт сервиса свободен. Повторный `aspire start` того же профиля снова доводит `auction` до `Healthy`: блокировку сервера sbt узел сборки не оставляет. Отработал ли при остановке `CoordinatedShutdown`, прогон не видел — логи ресурса уходят вместе с AppHost.
32. Прямой вызов `sbt` из AppHost не работает на Windows: `sbt` там — `sbt.bat`, и `cmd.exe` разбирает кавычки и скобки выражения `set` как свой синтаксис, узел сборки падает на разборе. Поэтому `auction-build` зовёт рецепт `just auction-classpath`, где аргумент разбирает bash.

Более ранние прогоны, которые прогоны PER-228, PER-208, PER-174, PER-5 и PER-290 не повторяли и не отменяют:

33. Профиль `identity` завершает `identity-proto` и `identity-build` с кодом 0 и доводит Identity до `Healthy`; NATS в этом профиле не поднимается. Identity запущен собранным бинарником из `apps/identity/bin`, получает `IDENTITY_DATABASE_URL` с `sslmode=disable` и слушает назначенный Aspire порт, а после `aspire stop` процесса `identity.exe` в системе не остаётся.
34. Профиль `meetups` после PER-58 поднимает здоровые PostgreSQL, `meetups-db` и Meetups. Полный интеграционный набор с Docker/Testcontainers проходит 53 теста без пропусков.
35. Профиль `notifications` после PER-212 поднимает здоровые PostgreSQL, `notifications-db` и Notifications: в логах видно применение миграций DbUp до подъёма силоса, затем `Orleans Silo started.`, а проба отвечает `SERVING` и через proxy endpoint, и напрямую.

## Неподтверждённая граница

Тестовая среда Telegram живым прогоном не проверена: полный `hub` прогнан в продакшн-среде отдельным локальным ботом, а с `--telegram-environment test` проверка доходит только до отказа графа на неизвестном имени. Закрывающая команда — `aspire run --apphost infra/apphost/AppHost.csproj -- --profile hub --telegram-environment test` с токеном тестового BotFather в `Parameters:telegram-bot-test-token` ([ADR-046](../decisions/ADR-046-telegram-test-contour.md)); регулярный прогон тестового контура ведёт [PER-9](https://linear.app/anticnvm/issue/per-9). Отрисовку ответа бота подтверждает клиент владельца (пункт 20), а не лог: запись границы говорит, что update обработан, но не то, как ответ выглядит у человека. В прогоне PER-228 бот писал успех на `debug`, и записи не было вовсе; с [PER-351](https://linear.app/anticnvm/issue/per-351) она на `info`.

Два запуска `aspire run` из разных рабочих деревьев делят один том `solguficky-postgres-data`: на прогоне PER-174 второй AppHost поднял свой PostgreSQL на том же томе, удалил `postmaster.pid`, и первый PostgreSQL ушёл в immediate shutdown. Пока том не разведён по запускам ([PER-340](https://linear.app/anticnvm/issue/per-340)), профиль с PostgreSQL в двух деревьях одновременно не запускают.

Токен бота сообщества способом проверки не является ни в какой среде: живой бот начал бы отвечать реальным людям, а второй polling-экземпляр получает от Telegram `409 Conflict` и способен уронить работающего бота. AppHost различает среду, а не бота, поэтому под `telegram-bot-token` на машине разработчика лежит токен отдельного локального бота, а не бота сообщества.

У самого узла бота понятия готовности в терминах AppHost нет: он не слушает порт, а ходит наружу long polling, поэтому пробы у него не будет и `WaitFor` на него не ставит никто. Его готовность читается собственной строкой лога, и «узел `Running`» подтверждением работы в Telegram не является.

Шина поднимается с топологией, но не используется: ни один компонент в NATS не пишет и из него не читает, поэтому зелёный узел `nats` на дашборде означает работающий брокер со стримами, а не работающую интеграцию. Пункты 16–19 проверены ручным потребителем `nats-tester`, а не Notifications. Пригодность `aspire publish` для production-like k3s и сама production-топология не проверены. Локальный успешный прогон не является подтверждением deployment-пути.

## Повторная проверка

Механический гейт запускается из корня:

```powershell
just verify
```

Живой gate требует отдельных запусков профилей `infra`, `identity`, `meetups` и `notifications`, среза `hub` без Telegram Bot и его повтора на том же томе, среза по одному сервису, полного `hub` с отдельным локальным ботом и `/start` к нему, а после появления тестового токена — и полного `hub` с `--telegram-environment test`. Токен бота сообщества способом проверки не является ни на одном шаге. Порядок в каждом запуске один: дождаться каждого ожидаемого ресурса через `aspire wait`, сверить граф и health через `aspire describe`, проверить баннер топологии и логи, затем вызвать `IdentityService/ResolveIdentity` и любую операцию `MeetupsService` через найденные в Aspire proxy endpoint и после каждого запуска штатно остановить AppHost. Не используй фиксированный порт: endpoint назначает Aspire.

Работа и её прогресс должны быть заведены в Linear; этот документ хранит только устойчивые правила и проверяемый gap.
