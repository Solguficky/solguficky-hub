# Notifications

Сервис отвечает на вопрос «кому и что положено прислать». На вопрос «дошло ли» он не отвечает и отвечать отказывается: ответственность, границы и две плоскости взаимодействия описаны в [docs/services/notifications.md](../../docs/services/notifications.md), решения — в [ADR-028](../../docs/decisions/ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md) и [ADR-029](../../docs/decisions/ADR-029-notifications-orleans-stack.md).

Сейчас сервис умеет подписки и настройки категорий — шесть синхронных операций контракта поверх своей схемы — и напоминание за сутки: материализованное задание со sweeper'ом, которое ведёт поток событий Meetups и которое на срабатывании разворачивается на подписчиков адресными фактами `meetup_reminder`. Обе ручные рассылки реализованы: право подтверждает владелец ресурса синхронным вызовом, а принятая команда разворачивается адресными фактами тем же outbox, что и автоматические поводы. Что есть и чего намеренно нет — ниже.

## Раскладка

| Проект | Ответственность |
|---|---|
| `Notifications` | силос Orleans, co-hosted с gRPC-сервером; миграции, грины, доступ к базе |
| `Notifications.Contracts` | generated-only: C# из `contracts/proto/notifications/v1` и импортируемого `meetups/v1`, события реплики и клиенты `CheckMeetupAuthority` и `CheckGlobalRole` |
| `Notifications.UnitTests` | словарь категорий, вывод действующего значения, разбор входящих полей, решение по заданию напоминания, раскладка миграций и строка подключения; базы не требует |
| `Notifications.IntegrationTests` | ограничения схемы, команды через настоящий gRPC-канал, рестарт силоса, жизненный цикл задания и простой кластера на PostgreSQL через Testcontainers |
| `Notifications.TestKit` | утилиты обоих тестовых наборов: `EventFactory` — валидные события Meetups и Identity; ссылается только на `Notifications.Contracts` |

Внутри `Notifications`: `Migrations.cs` и `Migrations/*.sql` — схема; `NotificationsHost.cs` — composition root; `Domain/` — словарь категорий и вывод действующего значения, без ввода-вывода; `Preferences/` — операции подписок и настроек; `Reminders/` — чистое решение по заданию напоминания, его настройки и sweeper; `Infrastructure/` — доступ к данным; `Transport/` — граница gRPC; `Grains/` — грины.

Границу между `Domain/` и остальным держит одно правило: продуктовое правило обязано проверяться без живой базы. Поэтому хранилище отдаёт только заданные человеком значения, а умолчание и наследование выводит чистая функция; уедь вывод в SQL — те же утверждения потребовали бы Docker.

Операция идёт одной транзакцией вместе со снимком, который она возвращает (`Infrastructure/UnitOfWork.cs`). Иначе между записью и чтением встаёт чужой коммит, и клиент получает успех на свою команду вместе с чужим значением. По той же причине у хранилищ нет своего соединения: два хранилища, открывшие по своему, собрали бы ответ из двух состояний базы.

## Стек

- **Orleans 10.3.1**, силос co-hosted в том же процессе, что и gRPC-сервер.
- **Clustering — `Microsoft.Orleans.Clustering.AdoNet`** в своей базе PostgreSQL.
- **Grain storage не зарегистрирован**, и это решение, а не пропуск. Источник истины остаётся в PostgreSQL ([ADR-029](../../docs/decisions/ADR-029-notifications-orleans-stack.md)); отсутствие провайдера превращает это правило в исполнимое — `[PersistentState]` роняет первую активацию грина `BadProviderConfigException`, вместо того чтобы молча завести вторую модель состояния. Силос при этом стартует, поэтому гейтом служит интеграционный тест, который грин активирует; механика — в [разборе](../../docs/learning/orleans/grains-and-cluster.md).
- **Reminders — `Microsoft.Orleans.Reminders.AdoNet`**, и правило выше они не ослабляют. Reminder хранит определение напоминания, а не срабатывание: момент лежит строкой в `reminder_task`, а рантайм только будит грин к нему. Тик, пришедшийся на простой кластера, Orleans не догоняет — поэтому корректность держит sweeper по таблице, а не этот провайдер.
- **Миграции — DbUp** из `Migrations/*.sql`, встроенных в сборку; **доступ к данным — Dapper** поверх Npgsql. Один механизм миграций на сервис: тем же DbUp применяются и вендорные скрипты Orleans.

## Схема

`meetup_subscription` — подписки: строка есть, значит человек следит за сходкой. Отписка удаляет строку, потому что контракт не различает «не подписывался» и «отписался».

`notification_preference` — настройки категорий одной таблицей: пустой `meetup_id` означает глобальную настройку, непустой — переопределение у сходки. Отсутствие строки читается как значение продукта по умолчанию, отсутствие переопределения — как наследование глобальной настройки. Именно поэтому правка глобального значения действует на все сходки, включая будущие: копии, которую пришлось бы догонять, не существует.

Два ограничения этой таблицы стоят в схеме, а не в обработчике. Частичные уникальные индексы — потому что обычный `UNIQUE` пропустил бы две глобальные строки одной категории: `NULL` не равен `NULL`. `CHECK` на область — потому что «новая опубликованная сходка» и «объявление сообществу» существуют только глобально, и держать это правило нужно против всех писателей в таблицу, а не только против gRPC-границы.

`grain_activation` — таблица про исполнение, а не про домен: сколько раз грин с этим ключом поднимался и на каком силосе.

`reminder_task` — материализованное задание напоминания, одно на сходку и её момент начала ([PER-221](https://linear.app/anticnvm/issue/per-221)). Состояний четыре: `scheduled`, `fired`, `cancelled`, `superseded`. Живое задание на сходку ровно одно, и это частичный уникальный индекс, а не соглашение в коде; завершённые остаются строками и копят историю переносов.

`broadcast` — принятая ручная рассылка: ключ идемпотентности команды и журнал разосланного ([PER-225](https://linear.app/anticnvm/issue/per-225)). Приём ключа и разворот на получателей идут одной транзакцией, повтор распознаёт первичный ключ, а не чтение перед записью.

`notification_occasion` — повод, порождённый сработавшим заданием, один на задание. Разворот на получателей идёт той же транзакцией строками `notification`, в шину их выносит общий релей ([PER-364](https://linear.app/anticnvm/issue/per-364)).

Рядом живут таблицы Orleans: `orleansquery`, `orleansmembershiptable`, `orleansmembershipversiontable`, `orleansreminderstable`. Их заводят вендорные скрипты `001_orleans_main.sql`, `002_orleans_clustering.sql` и `005_orleans_reminders.sql` — копии из `dotnet/orleans` на теге `v10.3.1`, адаптированные на идемпотентность; список правок стоит в шапке каждого файла.

## Транспорт

gRPC-сервер на Kestrel в h2c. Реализованы все восемь операций контракта: подписка, отписка, обе настройки категорий, оба чтения и обе ручные рассылки. Проба готовности по `grpc.health.v1` и рефлексия отвечают с первого дня.

`BroadcastToMeetupSubscribers` спрашивает право у Meetups (`CheckMeetupAuthority`, адрес в `NOTIFICATIONS_MEETUPS_GRPC_URL`), `BroadcastToCommunity` — у Identity (`CheckGlobalRole`, адрес в `NOTIFICATIONS_IDENTITY_GRPC_URL`), на самой команде и без реплики. Адрес не задан или владелец недоступен — рассылка отвечает `UNAVAILABLE`, а не уходит без проверки. Сообщение организатора получают подписчики сходки с включённой категорией, объявление — круг хаба с включённой глобальной категорией; число отобранных и отсечённых настройками уходит в запись `operation = broadcast` (поля `facts_created` и `facts_suppressed`) и в метрику `notifications.facts.*`, а не в ответ автору. Коды отказов — в [каталоге интеграций](../../docs/architecture/integration.md).

Команда предъявляет только `identity_id`. Ролей в запросах нет намеренно: свои подписки и настройки человек меняет себе, и решения о доступе по ролям сервис не принимает — разбор в [каталоге интеграций](../../docs/architecture/integration.md).

HTTP-эндпоинтов health у сервиса нет: Kestrel слушает только HTTP/2, как у Meetups. Пустое имя в `grpc.health.v1` отвечает liveness и базу не спрашивает; имя `notifications.v1.NotificationsService` отвечает готовностью с `select 1` через пул сервиса (`Infrastructure/DatabaseReadiness.cs`), и его спрашивает проба Aspire.

Каждый gRPC-вызов записывает граница `Transport/BoundaryLogInterceptor.cs` ([PER-363](https://linear.app/anticnvm/issue/per-363)). Недоступная база отвечает `Unavailable` с `error_category: dependency_unavailable`: пул сервиса получает `Timeout=2`, если строка подключения не задала свой, а clustering и reminders Orleans остаются на своих пределах. Правило общее для трёх сервисов — [ADR-054](../../docs/decisions/ADR-054-storage-unavailability-visible-outside.md).

## Запуск

Через Aspire — профиль `notifications` или `hub`:

```bash
aspire run -- --profile notifications
```

Вне Aspire нужна своя база; адрес берётся из `NOTIFICATIONS_DATABASE_URL` и принимает обе формы — готовую строку Npgsql и URI `postgres://…`. Пояс сообщества `NOTIFICATIONS_COMMUNITY_TIME_ZONE` (IANA) обязателен: без него процесс не стартует:

```bash
NOTIFICATIONS_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/notifications NOTIFICATIONS_COMMUNITY_TIME_ZONE=Europe/Moscow just notifications-run
```

Миграции применяются при старте процесса, до подъёма силоса: без таблиц membership силос не поднимется.

## Проверки

```bash
just notifications-build
just notifications-test
just notifications-test-integration
just notifications-contracts-check
```

`just notifications-test` гоняет только `Notifications.UnitTests` и Docker не требует. Интеграционные тесты требуют Docker: без него `just notifications-test-integration` падает — пропуск роняет прогон и локально, и в CI.

Сценарий «кластер лежал в момент срабатывания» поднимает сервис настоящим дочерним процессом и убивает его деревом, поэтому требует собранного `Notifications` рядом с тестовым проектом — `just notifications-build` перед прогоном, или просто `just notifications-test-integration`, который собирает интеграционный проект вместе с сервисом.
