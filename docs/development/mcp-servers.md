# MCP-серверы для контура агента

> **Статус:** Research, 2026-09-06. Документ сравнивает дополнительные MCP-серверы для [контура исполнения](agent-execution-loop.md). Он не разрешает установку или выдачу доступа.

В исследовании не устанавливались серверы, не запрашивались секреты и не выдавался write/admin-доступ. Linear и GitHub уже используются контуром, Aspire и Context7 вынесены в PER-91 и PER-134, поэтому они не считаются новыми кандидатами.

## Повторяемые сценарии

| Сценарий | Шаг контура или место в репозитории | Текущее средство | Нужен ли новый MCP |
|---|---|---|---|
| Проверить `delegate`, статус, связи и комментарии задачи; оставить отчёт | захват, чтение, отчёт | Linear MCP | нет |
| Прочитать PR, checks и review threads; открыть PR | ревью и сдача | GitHub MCP или `gh` | нет |
| Свериться с актуальной документацией зависимости | чтение и реализация | web и запланированный Context7 | нет |
| Дождаться ресурсов AppHost, прочитать health, логи и traces | гейт; [local-development.md](local-development.md) | Aspire CLI и запланированный Aspire MCP | нет нового кандидата |
| Проверить локальную веб-поверхность глазами пользователя | гейт; Aspire dashboard, будущий Mini App | ручной браузер | да, браузерный MCP |
| Разобрать Loki при красном живом гейте | гейт и стоп-триггер | Grafana UI, файлы логов, Aspire | возможно, Grafana MCP |
| Прогнать живой путь `/start` от пользователя до ответа бота | неподтверждённая граница в [architecture overview](../architecture/overview.md) | component-тесты и отдельный живой запуск | Telegram MCP не закрывает сценарий безопасно |
| Посмотреть схему и данные тестовой PostgreSQL при падении интеграционного теста | `just identity-test` | миграции, тесты и SQL-клиент | отдельный MCP не окупается |

Новые кандидаты нужны только четырём последним сценариям. Filesystem, Git и shell MCP не добавляют возможности среде агента, которая уже читает рабочее дерево и запускает команды; дополнительный сервер лишь создаст второй периметр записи.

## Как искали и проверяли

Источниками служили [официальный MCP Registry](https://registry.modelcontextprotocol.io/), документация издателей и репозитории самих серверов. Агрегаторы и списки «лучших MCP» не использовались. Поиск Registry выполнялся отдельно для `playwright`, `chrome-devtools`, `grafana`, `telegram`, `postgres` и `nats`; повторяющиеся версии одной записи считались одним сервером.

Read-only smoke ограничен публичной поверхностью: Registry, metadata npm, документация и локальные preconditions. Запуск `npx`/`uvx` загрузил бы пакет и нарушил границу задачи, поэтому ни один MCP-процесс не запускался.

## Сравнение кандидатов

| Кандидат | Сценарий и доступ | Авторизация | Сопровождение | Windows | Облачный агент | Пересечение |
|---|---|---|---|---|---|---|
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Навигация, accessibility snapshot, ввод, сеть и screenshot; браузер действует от имени пользователя | для localhost не нужна; storage state и профиль могут содержать сессию | Microsoft, Apache-2.0, официальный Registry и npm `@playwright/mcp` | документирован нативный профиль; Node ≥18 | stdio требует браузер и пакет внутри VM; HTTP можно поднять самостоятельно, hosted-сервиса нет | ручной браузер, Chrome DevTools MCP |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/get-started) | DOM, console, network и performance trace живого Chrome | отдельный токен не нужен; подключённый профиль передаёт авторизованную сессию | Chrome DevTools, Apache-2.0, официальный Registry и npm | Chrome и Edge доступны; пакет требует поддерживаемый Node | stdio и браузер должны быть внутри VM либо Chrome должен быть доступен по remote debugging | Playwright MCP; ценность выше для отладки и performance |
| [Grafana MCP](https://grafana.com/docs/grafana/latest/developer-resources/mcp/) | dashboards, datasources и Loki; сервер также содержит write-tools | service-account token или basic auth; hosted Grafana Cloud использует OAuth | Grafana Labs, официальный Registry и Docker image | binary, Docker или `uvx`; нативность зависит от выбранного способа запуска | локальная Grafana из другой VM недоступна; Grafana Cloud имеет hosted HTTP | Aspire уже даёт health, logs и traces внутреннего цикла |
| Telegram Bot API MCP | обёртки над `sendMessage`, `getUpdates` и другими Bot API methods | bot token; MTProto-варианты требуют user session | в Registry только сторонние издатели; официального сервера Telegram нет | зависит от community runtime | требует секрет в среде агента и сетевой доступ к Telegram | конфликтует с long polling продукта и минимальными правами |
| PostgreSQL MCP | schema inspection и SQL | connection URI с учётными данными | прежний [reference server архивирован](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres); живые варианты сторонние | обычно Node, Python/`uv` или Docker | URI базы должен быть доступен VM; локальная база другого хоста не видна | миграции, интеграционные тесты и SQL-клиент |
| NATS MCP | subjects, publish/subscribe и диагностика | адрес и, при защищённом NATS, credentials | Registry находит только сторонние серверы, официального сервера NATS нет | зависит от community runtime | нужен доступ к локальной шине | `tools/nats-tester`, NATS CLI и будущий Aspire MCP |

`--disable-write` у Grafana удаляет write-tools, но query-tools следует ограничивать отдельно: документация предупреждает, что raw SQL может писать через datasource. Безопасный профиль для Loki должен включать только search/datasource/Loki и read-only service account, а не полагаться на один флаг.

## Итоги и эксплуатационная цена

### Playwright MCP — ставить после выбора владельца

Это единственный кандидат, который закрывает существующую ручную операцию без секрета: проверку Aspire dashboard и будущей веб-поверхности через структурированное дерево доступности. Для тестового контура нужен `--isolated`; постоянный профиль хранит cookies на диске и занят одним browser instance, а extension-режим раскрывает агенту уже авторизованные вкладки. Сервер следует подключать только к localhost/test-среде и отдельному профилю.

Цена: проектная конфигурация для поддерживаемых клиентов, Node, загрузка browser binaries и отдельная проверка на Windows и в облачной среде. Риск: prompt injection со страницы и действия от имени пользователя. Нельзя подключать рабочий браузерный профиль.

Smoke: Registry вернул `io.github.microsoft/playwright-mcp`; npm сообщил версию `0.0.80`, Apache-2.0 и Node ≥18; на машине есть Node 26.4, Chrome и Edge. Процесс не запускался, потому что `npx` загрузил бы сервер.

### Chrome DevTools MCP — проверить позже

Сервер сильнее Playwright в console/network/performance diagnosis, но собственной веб-поверхности в MVP пока нет, а dashboard не оправдывает два браузерных MCP. Вернуться к кандидату при появлении Mini App или повторяемой browser-performance диагностики.

Цена: Chrome плюс Node и remote-debugging lifecycle. Риск: [официальная документация](https://developer.chrome.com/docs/devtools/agents/get-started) прямо предупреждает, что агент видит и меняет данные подключённого браузера. Smoke: официальный Registry и npm доступны, npm сообщил `1.8.0`, Apache-2.0 и совместимость с установленным Node; запуск потребовал бы загрузки пакета.

### Grafana MCP — проверить позже

Кандидат становится полезен, когда чтение Loki действительно повторяется после красного живого гейта. Сейчас Aspire уже покрывает ближайший сценарий, а локальная Grafana на `127.0.0.1:3000` во время smoke не работала, поэтому проверить `query_loki_logs` невозможно без запуска стека, установки сервера и service-account token.

Цена: отдельный binary/container/`uvx`, read-only service account и явный allowlist инструментов. Риск: широкие LogQL/SQL-запросы и write-возможности при ошибочной конфигурации. Для Grafana Cloud hosted MCP уменьшает сопровождение, но добавляет внешний OAuth-доступ к телеметрии.

### Telegram Bot API и MTProto MCP — отклонить

Bot API действует от имени бота и не может воспроизвести пользовательский `/start`: [Telegram FAQ](https://core.telegram.org/bots/faq) подтверждает, что бот не видит сообщения другого бота. Чтение апдейтов отдельным MCP конкурирует с единственным long-polling процессом, закреплённым в [ADR-030](../decisions/ADR-030-telegram-bot.md); Bot API отдельно фиксирует взаимоисключение `getUpdates` и webhook. MTProto решило бы роль пользователя ценой полноценной сессии человека, что нарушает privacy by design и минимальные права.

Цена: отдельный test bot/token либо user session, управление очередью updates и защита от отправки в реальные чаты. Риск: потерянные апдейты, конфликт поллеров и действия от имени бота/человека. Корректный живой e2e следует проектировать отдельным тестовым контуром, а не выдавать общему MCP полный Telegram-доступ.

### PostgreSQL MCP — отклонить

Интеграционные тесты уже создают контролируемую базу, а схема читается из миграций. Архивный reference server не получает исправлений; актуальные сторонние варианты расширяют поверхность доступа и требуют connection URI. Во время smoke порт `127.0.0.1:5432` отвечал, но подключение без выданных для задачи credentials намеренно не выполнялось.

Цена: секрет, lifecycle сервера и отдельная политика read-only. Риск: запрос не ограничен тестовой базой либо сервер допускает write. При редкой диагностике SQL-клиент прозрачнее и дешевле.

### Отдельный NATS MCP — отклонить

Официального сервера NATS в Registry нет; найденные записи сторонние. Для контрактных сообщений в репозитории уже есть `tools/nats-tester`, а состояние ресурсов и логи должен закрыть Aspire MCP. Новый сервер дублирует оба пути и добавляет publish-доступ к шине.

Цена: ещё один runtime и credentials. Риск: публикация некорректного сообщения и ложное ожидание надёжной доставки от Core NATS.

## Рекомендация владельцу

Выбрать только Playwright MCP для отдельной задачи подключения с `--isolated`, запретом рабочего browser profile и проверкой нативного Windows-клиента плюс облачного агента. Chrome DevTools и Grafana оставить контрольными кандидатами до появления повторяемого сценария. Telegram, PostgreSQL и NATS MCP не подключать.

Follow-up задачи этим исследованием не создаются: по границе PER-135 они появляются только после выбора владельца.
