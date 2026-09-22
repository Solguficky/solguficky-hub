# Notifications

Сервис отвечает на вопрос «кому и что положено прислать». На вопрос «дошло ли» он не отвечает и отвечать отказывается: ответственность, границы и две плоскости взаимодействия описаны в [docs/services/notifications.md](../../docs/services/notifications.md), решения — в [ADR-028](../../docs/decisions/ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md) и [ADR-029](../../docs/decisions/ADR-029-notifications-orleans-stack.md).

Сейчас здесь силос, схема, грин на сходку и напоминание за сутки. Что сервис умеет и чего в нём намеренно нет — ниже.

## Раскладка

| Проект | Ответственность |
|---|---|
| `Notifications` | силос Orleans, co-hosted с gRPC-сервером; миграции, грины, доступ к базе |
| `Notifications.Contracts` | generated-only: C# из `contracts/proto/notifications/v1` и импортируемого `meetups/v1` |
| `Notifications.UnitTests` | раскладка миграций, разбор строки подключения и решение по заданию напоминания; базы не требует |
| `Notifications.IntegrationTests` | схема, рестарт силоса, жизненный цикл задания и простой кластера на настоящем PostgreSQL через Testcontainers |

Внутри `Notifications`: `Migrations.cs` и `Migrations/*.sql` — схема; `NotificationsHost.cs` — composition root; `Grains/` — грины; `Reminders/` — чистое решение по заданию, его настройки и sweeper; `Infrastructure/` — доступ к данным.

## Стек

- **Orleans 10.3.1**, силос co-hosted в том же процессе, что и gRPC-сервер.
- **Clustering — `Microsoft.Orleans.Clustering.AdoNet`** в своей базе PostgreSQL.
- **Grain storage не зарегистрирован**, и это решение, а не пропуск. Источник истины остаётся в PostgreSQL ([ADR-029](../../docs/decisions/ADR-029-notifications-orleans-stack.md)); отсутствие провайдера превращает это правило в исполнимое — `[PersistentState]` роняет первую активацию грина `BadProviderConfigException`, вместо того чтобы молча завести вторую модель состояния. Силос при этом стартует, поэтому гейтом служит интеграционный тест, который грин активирует; механика — в [разборе](../../docs/learning/orleans/grains-and-cluster.md).
- **Reminders — `Microsoft.Orleans.Reminders.AdoNet`**, и правило выше они не ослабляют. Reminder хранит определение напоминания, а не срабатывание: момент лежит строкой в `reminder_task`, а рантайм только будит грин к нему. Тик, пришедшийся на простой кластера, Orleans не догоняет — поэтому корректность держит sweeper по таблице, а не этот провайдер.
- **Миграции — DbUp** из `Migrations/*.sql`, встроенных в сборку; **доступ к данным — Dapper** поверх Npgsql. Один механизм миграций на сервис: тем же DbUp применяются и вендорные скрипты Orleans.

## Схема

`grain_activation` — таблица про исполнение, а не про домен: сколько раз грин с этим ключом поднимался и на каком силосе.

`reminder_task` — материализованное задание напоминания, одно на сходку и её момент начала ([PER-221](https://linear.app/anticnvm/issue/per-221)). Состояний четыре: `scheduled`, `fired`, `cancelled`, `superseded`. Живое задание на сходку ровно одно, и это частичный уникальный индекс, а не соглашение в коде; завершённые остаются строками и копят историю переносов.

`notification_occasion` — повод, порождённый сработавшим заданием, один на задание. Разворот на получателей и публикация в шину — PER-72.

Таблицы подписок и настроек приносит PER-213.

Рядом живут таблицы Orleans: `orleansquery`, `orleansmembershiptable`, `orleansmembershipversiontable`, `orleansreminderstable`. Их заводят вендорные скрипты `001_orleans_main.sql`, `002_orleans_clustering.sql` и `005_orleans_reminders.sql` — копии из `dotnet/orleans` на теге `v10.3.1`, адаптированные на идемпотентность; список правок стоит в шапке каждого файла.

## Транспорт

gRPC-сервер на Kestrel в h2c. Реализаций сервиса пока нет — command plane это PER-71, — но проба готовности по `grpc.health.v1` и рефлексия отвечают с первого дня, поэтому появление команд не меняет ни конфигурацию Kestrel, ни узел AppHost.

HTTP-эндпоинтов health у сервиса нет: Kestrel слушает только HTTP/2, как у Meetups.

## Запуск

Через Aspire — профиль `notifications` или `hub`:

```bash
aspire run -- --profile notifications
```

Вне Aspire нужна своя база; адрес берётся из `NOTIFICATIONS_DATABASE_URL` и принимает обе формы — готовую строку Npgsql и URI `postgres://…`:

```bash
NOTIFICATIONS_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/notifications just notifications-run
```

Миграции применяются при старте процесса, до подъёма силоса: без таблиц membership силос не поднимется.

## Проверки

```bash
just notifications-build
just notifications-test
just notifications-contracts-check
```

Интеграционные тесты требуют Docker: без него они пропускаются локально и красят джобу в CI.

Сценарий «кластер лежал в момент срабатывания» поднимает сервис настоящим дочерним процессом и убивает его деревом, поэтому требует собранного `Notifications` рядом с тестовым проектом — `just notifications-build` перед прогоном, или просто `just notifications-test`, который собирает решение целиком.
