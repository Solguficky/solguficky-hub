# Архитектурный обзор

> **Статус:** Canonical для общего состояния Current / MVP / Future. Фактическое поведение подтверждается кодом и конфигурацией; принятые решения — ADR.

## Как читать статусы

Временной слой и зрелость решения — разные характеристики.

| Слой | Значение |
|---|---|
| **Current** | Фактически существует в репозитории |
| **MVP** | Требуется для первой живой сходки через бота |
| **Future** | Возможное направление после MVP без текущего обязательства реализации |

| Зрелость | Значение |
|---|---|
| **Accepted** | Направление принято; нетривиальное техническое решение закрепляется ADR |
| **Proposed** | Есть предпочтительный вариант, но решение ещё проектируется или утверждается |
| **Open** | Варианты исследуются |
| **Superseded** | Решение больше не определяет целевую архитектуру |

Например, у Telegram Bot устройство и стек приняты в [ADR-030](../decisions/ADR-030-telegram-bot.md), а четырнадцать пользовательских операций бот → Meetups идут синхронным gRPC ([integration.md](integration.md)). Scala/Pekko-аукцион относится к Future: стек и хранилище приняты в [ADR-045](../decisions/ADR-045-auction-scala-pekko-persistence-jdbc.md), доменная модель торгов принята в [RFC-011](../rfcs/RFC-011-auction-trading-domain-model.md), а словарь и форма события зафиксированы [ADR](../decisions/ADR-047-auction-trading-domain-vocabulary-and-event-form.md); схем и реализации ещё нет.

## Источники правды

При расхождении источников:

1. код, конфигурация, тесты и миграции определяют фактическое состояние;
2. действующие ADR с учётом замен определяют принятую архитектуру;
3. профильные документы `product/`, `architecture/` и `services/` определяют границы и открытые вопросы;
4. архив используется только как историческое свидетельство.

Linear является источником правды для порядка работ, milestones, задач и прогресса. Отдельного Git-roadmap нет.

## Current

Продуктовое ядро сходок реализовано у Meetups. У Notifications его нет: в репозитории лежит скелет сервиса — силос Orleans со своей базой и миграциями, без подписок, реплики и публикации. Meetups держит доменное ядро среза и отвечает на пятнадцать операций контракта своими срезами: одиннадцать команд записи, три продуктовых запроса чтения со смотрящим и служебное перечисление состояний. Identity разрешает Telegram-личность во внутренний идентификатор. Telegram Bot обрабатывает `/start`, создаёт или повторно разрешает профиль через Identity и отвечает приветствием. Репозиторий содержит контракты, инфраструктурный задел и инструменты.

| Компонент | Фактическое состояние | Отношение к MVP |
|---|---|---|
| Telegram Bot | Long polling, Identity на каждом продуктовом действии, форма создания и публикации, список видимых сходок и карточка с deep link `m_<uuid>`; карточка по умолчанию использует Rich Messages, плоский рендерер включается тоглом процесса | Единственный вход пользователя |
| Meetups | gRPC-сервис на F#: доменное ядро обеих осей состояния и коллекции материалов, пятнадцать операций контракта своими срезами, запись состояния и события одной транзакцией с отклонением конфликта по версии, чтение со смотрящим через единый reader с фильтром видимости ADR-022, health, каркас лога границы и миграции состояния и журнала событий с отметкой публикации | Владелец данных о сходках |
| Identity | gRPC-сервер: `ResolveIdentity` поверх PostgreSQL, health, структурные логи и миграции профиля и глобальных ролей | Telegram identity, круги сообщества и системные роли |
| Notifications | Скелет: силос Orleans, своя база, миграции при старте, грин на сходку | Подписки, реплика чужих фактов и публикация уведомлений в шину |
| Mini App | Отсутствует | Вне MVP, см. [service brief](../services/mini-app.md) |
| `contracts/proto` | Identity `ResolveIdentity`, шесть команд администратора и ещё не реализованный `ResolveTelegramUserId` с Go- и TypeScript-кодогенерацией, словарь исходящих событий доступа `identity.v1.IdentityEvent`, пятнадцать gRPC-операций среза Meetups и словарь их исходящих событий `meetups.v1.MeetupEvent`, восемь операций command plane Notifications и словарь публикуемых уведомлений `notifications.v1.Notification`; обе схемы `notifications/v1` потребляет контрактный проект Notifications, и модуль целиком собирает джоба `contracts` | Current |
| `nats-tester` | Python CLI; в реестре subjects семнадцать записей — `events.notifications.notification_created`, одиннадцать поводов журнала Meetups и пять поводов доступа Identity; гейт выводит имена subjects из схемы и сверяет конверт событий обоих доменов с одной спецификацией | Current tooling |
| Aspire AppHost | Граф узлов и профили-данные; состав подтверждённого живым прогоном ведёт [руководство по локальной разработке](../development/local-development.md), непроверенной остаётся тестовая среда Telegram | Current, partially verified |

Наличие принятого решения не означает наличия кода, а наличие кода не означает production readiness. В частности, не подтверждены живым прогоном ни тестовая среда Telegram, ни end-to-end через живого Telegram-бота до отрисовки ответа, ни production deployment.

## MVP

| Область | Зрелость | Направление |
|---|---|---|
| Telegram Bot | Устройство и стек Accepted: [ADR-030](../decisions/ADR-030-telegram-bot.md); форма сообщений Accepted: [ADR-034](../decisions/ADR-034-telegram-bot-rich-presentation.md) | TypeScript + grammY, long polling, состояние экрана в самом сообщении; карточка по умолчанию `sendRichMessage`, плоский текст за тоглом процесса. Будущий общий слой аукциона и второй процесс определены ADR-044 |
| Meetups | Граница, техническая модель, стек, внутренние application slices, словарь домена и gRPC-контракт среза Accepted: ADR-024, ADR-025, ADR-031, ADR-033, [integration.md](integration.md) | Владелец продуктовых данных сходок |
| Identity | Граница, модель доступа, retention допуска к хабу и стек Accepted: ADR-026, ADR-027, [ADR-038](../decisions/ADR-038-identity-hub-access-retention.md); круги сообщества выражаются ролями, статус допуска заменён, блокировка — поле профиля: [ADR-043](../decisions/ADR-043-identity-roles-and-community-circles.md); первая выдача роли администратора в срезе — только служебный endpoint: [ADR-036](../decisions/ADR-036-first-admin-via-service-endpoint.md); authentication endpoint — общий секрет в metadata gRPC: [ADR-037](../decisions/ADR-037-identity-maintainer-shared-secret.md); контракт разрешения личности Accepted, служебные операции Open | Telegram identity, круги сообщества и системные роли |
| Notifications | Устройство, границы и стек Accepted: ADR-028, ADR-029; технический дизайн скелета зафиксирован, схема подписок Open | Подписки, реплика чужих фактов и публикация уведомлений в шину |
| Mini App | Вне MVP, Deferred | Ни один сценарий MVP не требует второго клиента |
| Local orchestration | Accepted, partially verified | Aspire как inner loop; механизм режимов заменён профилями-данными ([ADR-021](../decisions/ADR-021-aspire-local-orchestration.md), пересмотр 2026-09-04) |
| Production hosting | Accepted, not implemented | Начальный self-hosting размещается вместе с dev/agents/test на одном Linux VPS; отдельный production VPS вводится по сигналам ADR-039 |
| Contract governance | Open, частично закрыто | Раскладка контрактов, Go, .NET и TypeScript codegen приняты; CI breaking checks и `buf lint` введены, Schema Registry остаётся открытым |

Основной архитектурный поток строится вокруг сходок.

## Future

- Аукцион — Future-направление после MVP: новый сервис на Scala 3 + Apache Pekko Typed с полным Event Sourcing через Pekko Persistence JDBC в PostgreSQL ([ADR-045](../decisions/ADR-045-auction-scala-pekko-persistence-jdbc.md)). Знание, извлечённое из удалённой реализации, собрано в [архиве](../archive/services/auction-domain-and-lessons.md); схемы и реализации ещё нет.
- Аукцион доступен через два независимых TypeScript/grammY-процесса: `telegram-bot` и `auction-bot`. Общими являются только аукционные юзкейсы края, каноническое тело экрана и кнопки в `shared/typescript/auction-bot-ui`; политики входа, оболочки, тексты и токены раздельны ([ADR-044](../decisions/ADR-044-two-telegram-bots-and-shared-auction-screens.md)). `hub` сохраняет только бот хаба; профиль для одновременного запуска обоих ресурсов появится вместе со вторым приложением.
- Read-only Big Screen и страницы зрителей получают состояние через SSE внутри Auction Service ([ADR-040](../decisions/ADR-040-auction-screen-sse.md)); отдельный gateway не вводится. Решение принято, реализации ещё нет.
- Achievements + Orleans — Future-гипотеза, а не спроектированный сервис.
- Kotlin, Go и Ruby остаются technology pool и не назначаются вымышленным сервисам заранее.

## Первый архитектурный срез

Состав среза утверждён владельцем и описан в [first-slice.md](first-slice.md): администратор создаёт и публикует сходку, солегуфик находит её и открывает карточку. Материалы сходки, уведомления и подписки в срез не входят.

Логическая зависимость:

```text
Telegram user
→ новый Telegram Bot на TypeScript
→ Identity
→ Meetups
→ наблюдаемый ответ пользователю
```

Это не roadmap. Transport четырнадцати пользовательских операций бот → Meetups зафиксирован как gRPC ([integration.md](integration.md)). Срез проверяет реальные границы сервисов, authentication/authorization, persistence, failure semantics и локальную оркестрацию. Порядок исполнения ведётся в Linear.

## Сквозные ограничения

- Аукцион не входит в MVP.
- Межсервисные NATS и gRPC payload используют Protobuf; JSON в шине не является целевым форматом.
- Core NATS не даёт durable delivery без JetStream consumers и согласованной идемпотентности.
- Язык назначается существующей задаче после требований.
- Продуктовые и архитектурные решения принимает владелец; агент исследует, оппонирует и реализует утверждённый срез.

## Навигация

- [Межсервисное взаимодействие](integration.md)
- [Инфраструктурные контуры](infrastructure.md)
- [Выбор технологий](technology-selection.md)
- [Карта сервисов](../services/README.md)
- [Индекс ADR](../decisions/README.md)
- [Процесс проектирования](../development/design-process.md)
- [Локальная разработка](../development/local-development.md)
