# MCP-серверы для контура агента

> **Статус:** Draft research, 2026-09-05. Документ отвечает на один вопрос: какие MCP-серверы уменьшают ручные действия в [контуре исполнения](agent-execution-loop.md) сверх уже принятых Linear, GitHub и запланированных Aspire и Context7. Это исследование, а не разрешение ставить серверы.

Серверы в этом срезе не устанавливались, write/admin-доступ не выдавался, секреты не запрашивались и не сохранялись. Выбор и отдельные задачи на подключение остаются за владельцем.

Линейка «уже есть / запланировано» на дату среза: GitHub MCP и Linear MCP стоят; Aspire и Context7 запланированы владельцем. Они закрывают свои сценарии ниже и в сравнительную матрицу новых кандидатов не входят.

## Сценарии контура

Восемь повторяемых действий. Каждое привязано к шагу контура или к конкретному месту репозитория, а не к общей «полезности».

| # | Сценарий | Шаг контура / место в репозитории | Чем закрыт сейчас |
|---|---|---|---|
| 1 | Прочитать задачу, `delegate`, статус, комментарии и оставить отчёт | шаги 1, 3, 10 | Linear MCP; в этой облачной сессии сервер недоступен |
| 2 | Открыть PR, прочитать checks и review comments | шаги 8–9 | GitHub MCP; в этой сессии — `gh` CLI, не MCP |
| 3 | Поднять профиль Aspire, дождаться health, прочитать баннер и логи ресурса | шаг 6 и [local-development.md](local-development.md) | CLI `aspire start/wait`; MCP запланирован |
| 4 | Свериться с актуальной документацией библиотеки во время реализации | шаг 5 | ручной WebFetch; Context7 запланирован |
| 5 | Прогнать живой вертикальный срез Telegram-бота: пользователь пишет `/start`, бот отвечает | шаг 6 и e2e в [testing-strategy.md](../standards/testing/testing-strategy.md) | synthetic update без сети; живой Bot API в unit-контуре запрещён |
| 6 | Проверить веб-поверхность так, как её видит человек | шаг 6 и правило проверки UI | у облачного агента есть Computer Use; Mini App в MVP нет |
| 7 | Разобрать логи Loki при красном гейте | шаг 6, стоп-триггер «проверки красные» | `~/.aspire/logs/`, Grafana как задел |
| 8 | Понять схему PostgreSQL, когда падают интеграционные тесты Identity | шаг 6 и `just identity-test` | тесты и `testdb`; интерактивного MCP нет |

Сценарии 1–4 закрыты или уже выбраны владельцем. Новые кандидаты ниже отвечают только на 5–8.

## Метод поиска

Каталоги и первичные источники, без агрегаторов как источника истины:

- официальный MCP Registry, `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=…` ([спецификация реестра](https://github.com/modelcontextprotocol/registry));
- репозиторий reference-серверов [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — каталог больше не ведёт, указывает на Registry;
- документация издателя: Microsoft Playwright, Chrome for Developers, Grafana, GitHub, Telegram Bot API;
- метаданные npm и GitHub API (лицензия, дата пуша, релиз) без установки пакета.

Linear, Aspire и Context7 из поиска кандидатов исключены. GitHub MCP в матрицу новых не входит: он уже стоит.

## Сравнительная матрица

| Кандидат | Сценарий | Издатель и сопровождение | Транспорт | Авторизация | Доступ | Windows | Облачные агенты | Пересечения | Источник |
|---|---|---|---|---|---|---|---|---|---|
| Playwright MCP `io.github.microsoft/playwright-mcp` | 6 | Microsoft, Apache-2.0, npm `@playwright/mcp` 0.0.80, пуш 2026-09-04, 36k★ | stdio (`npx`); HTTP только как локальный standalone `--port` | не нужна | управление браузером: навигация, снимок a11y, клик, ввод, сеть, cookies | да: профиль `%USERPROFILE%\AppData\Local\ms-playwright\…` | stdio внутри VM; HTTP предпочтителен, у этого сервера hosted HTTP нет | Computer Use облачного агента; Chrome DevTools MCP | [playwright.dev/mcp](https://playwright.dev/mcp/introduction), [github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) |
| Chrome DevTools MCP `io.github.ChromeDevTools/chrome-devtools-mcp` | 6 | Google Chrome DevTools, Apache-2.0, npm `chrome-devtools-mcp` 1.8.0, пуш 2026-09-04, 50k★ | stdio (`npx chrome-devtools-mcp@latest`) | не нужна | живой Chrome: DOM, сеть, консоль, performance trace | да, если установлен Chrome | stdio + нужен Chrome в VM; на этой машине `/usr/local/bin/google-chrome` есть | Playwright MCP; Computer Use | [developer.chrome.com/docs/devtools/agents](https://developer.chrome.com/docs/devtools/agents/get-started) |
| Community Telegram Bot API MCP (`timoncool/telegram-api-mcp` и зеркала) | 5 | частный автор, MIT, 28★, в официальном Registry записи нет, пакет `telegram-api-mcp` в npm отсутствует (`@mseep/telegram-api-mcp` — зеркало) | stdio + опциональный HTTP | `TELEGRAM_BOT_TOKEN` | до 169 методов Bot API, включая send и `getUpdates` | формально Node | stdio в VM с секретом в env: Cursor считает это нежелательным | long polling бота; Computer Use на Telegram Web | [github.com/timoncool/telegram-api-mcp](https://github.com/timoncool/telegram-api-mcp) |
| MTProto / user-account Telegram MCP | 5 | разные community-серверы в Registry (`io.github.auroracapital/…` и аналоги) | stdio / HTTP | сессия пользовательского аккаунта | чтение и отправка от имени человека | как у рантайма сервера | сессия в VM недопустима | privacy by design, минимальные Telegram-права | записи Registry по `search=telegram` |
| Grafana MCP `io.github.grafana/mcp-grafana` | 7 | Grafana Labs, Apache-2.0, релиз v1.3.0 (2026-08-28), 3.4k★ | stdio (`uvx mcp-grafana`), Docker, binary; Cloud — hosted HTTP с OAuth | service account token или basic auth; Cloud — OAuth 2.1 | дашборды, Loki (`query_loki_logs`), datasource; есть `--disable-write` | через Docker Desktop или `uvx` | HTTP+OAuth для Cloud; локальный Grafana из облачной VM не виден | Aspire dashboard | [grafana/mcp-grafana](https://github.com/grafana/mcp-grafana), [docs Grafana](https://grafana.com/docs/grafana/latest/developer-resources/mcp/set-up/) |
| `@modelcontextprotocol/server-postgres` | 8 | reference MCP, **deprecated и в архиве**, без security-фиксов | stdio | connection string | задуман как read-only SQL | Node | stdio + секрет URI в VM | `just identity-test`, `testdb` | [npm @modelcontextprotocol/server-postgres](https://www.npmjs.com/package/@modelcontextprotocol/server-postgres) |
| Postgres MCP Pro `crystaldba/postgres-mcp` | 8 | Crystal DBA, MIT, 3.2k★, пуш 2026-08-17; в Registry по имени `crystaldba` не найден | stdio / SSE | connection string | read **и write** (настраивается) | Python/`uv` | stdio + URI в VM | то же | [github.com/crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) |
| `postgres-mcp-hardened` | 8 | community, MIT, 1★ | stdio / HTTP | URI | read-only на AST + `default_transaction_read_only` | бинарь/npm | HTTP возможен | то же | [github.com/Eszetael/postgres-mcp-hardened](https://github.com/Eszetael/postgres-mcp-hardened) |

Официального NATS MCP в Registry нет. Контрактный контур уже закрывает `nats-tester`; отдельный MCP под шину не искался как замена CLI.

## Сильнейшие кандидаты и smoke

### Playwright MCP — ставить

Закрывает сценарий 6 в локальном Cursor на Windows: headed-браузер, снимок accessibility tree, клик по `ref`, без отдельной модели зрения. Издатель — Microsoft, пакет в официальном Registry, релиз не старше недели. Авторизации нет. На Windows путь профиля задокументирован. Облачному агенту тот же сервер почти ничего не даёт: Computer Use уже водит браузер, а Playwright отдаётся только как stdio без hosted HTTP.

**Цена.** Запись в MCP-конфиге клиента, Node 20+, первая загрузка браузера Playwright. Постоянный профиль пишет cookies на диск; для тестовых сессий нужен `--isolated`, иначе два клиента на одном workspace конфликтуют.

**Риск.** Агент управляет браузером от имени пользователя. Подключать к уже залогиненной сессии (`--extension`) нельзя: это передаёт cookies. Для контура достаточно изолированного профиля и localhost/Aspire.

**Smoke.** Сервер не запускался: это была бы установка, запрещённая задачей. Проверена публичная поверхность: Registry отдаёт `io.github.microsoft/playwright-mcp` с транспортом `stdio`; `npm view @playwright/mcp` — 0.0.80, Apache-2.0; `https://playwright.dev/mcp/introduction` отвечает 200; репозиторий не archived, последний пуш 2026-09-04.

### Chrome DevTools MCP — проверить позже

Тот же сценарий 6, но через живой Chrome и DevTools: сеть, консоль, performance trace. Это отладка страницы, а не e2e-контур. Пока Mini App отложен и веб-поверхности продукта нет, Playwright закрывает проверку Aspire dashboard дешевле. Повторно смотреть, когда появится собственный HTML/Mini App.

**Цена.** Node LTS + установленный Chrome, stdio. **Риск.** Тот же, что у живого браузера с профилем пользователя; документация Chrome прямо предупреждает не подключать агента к залогиненной сессии.

**Smoke.** Документация `developer.chrome.com/docs/devtools/agents/get-started` отвечает 200; npm `chrome-devtools-mcp@1.8.0`; на этой VM Chrome есть, но сервер не запускался по той же причине, что Playwright.

### Telegram Bot API MCP — отклонить

Сценарий 5 настоящий: e2e «пользователь → бот → наблюдаемый ответ» в [testing-strategy.md](../standards/testing/testing-strategy.md) и в скилле `proj-write-grammy-bot` вынесен в отдельный контур. Кандидата под него в официальном Registry нет. Community-серверы оборачивают Bot API целиком.

Почему это не закрывает сценарий:

1. Bot API говорит **от имени бота**. Пользовательский `/start` так отправить нельзя. FAQ Telegram: боты не видят сообщения других ботов, поэтому «второй бот как водитель» тоже не работает без отдельного пользовательского входа.
2. `getUpdates` и webhook взаимоисключающи ([Bot API](https://core.telegram.org/bots/api#getting-updates)). Второй поллер на том же токене даёт 409 и гасит long polling продукта — ровно то, что запрещает [ADR-030](../decisions/ADR-030-telegram-bot.md): один процесс на токен.
3. Полный набор send-методов — write-доступ. Задача исследования write не выдаёт; прод-токен в MCP нельзя класть и после исследования.

User-account / MTProto MCP отклоняется жёстче: это сессия человека, не бота, и прямо спорит с минимизацией Telegram-прав.

Живой e2e остаётся отдельным контуром: отдельный test-бот, отдельный токен, synthetic update в unit/component, и только потом — решение, нужен ли узкий MCP из `getMe` / `sendMessage` на test-токене. До этого выбора сервер не ставить.

**Smoke.** `GET https://api.telegram.org/bot/getMe` без токена вернул `404 Not Found`. Вызов с токеном не делался. Пакет `telegram-api-mcp` в npm не найден; в Registry поиска `telegram-api-mcp` — 0 записей.

### Grafana MCP — проверить позже

Сценарий 7: при красном гейте прочитать логи Identity/бота. Официальный сервер Grafana это умеет (`query_loki_logs`, флаг `--disable-write`). Авторизация — service account token; для Grafana Cloud есть hosted MCP с OAuth. Локальный Grafana в этой сессии не слушал `:3000`, живой observability-контур в [local-development.md](local-development.md) ещё не закрыт. Ставить нечего, пока агент регулярно не смотрит Loki. Aspire dashboard частично пересекается и дешевле на старте.

**Цена.** Токен сервис-аккаунта с `datasources:query`, `uvx` или Docker, флаг `--disable-write` обязателен. **Риск.** Без флага сервер умеет менять дашборды и алерты. Широкий LogQL без guardrail сканирует большой объём.

**Smoke.** Документация Grafana MCP отвечает 200; репозиторий живой. Локальный инстанс и токен недоступны — вызов `query_loki_logs` невозможен без секрета и без установки.

### PostgreSQL MCP — отклонить

Сценарий 8 закрывают `just identity-test` и изолированные базы. Официальный reference-сервер в архиве. Сопровождаемые замены либо умеют write (Postgres MCP Pro), либо слишком малы (1★ hardened). Connection string в stdio-MCP попадает в VM облачного агента. Это не окупает ручной `psql` / чтение миграций.

**Smoke.** Живого Postgres на `:5432` в сессии не было; URI не запрашивался.

## Итоги

| Кандидат | Итог | Эксплуатационная цена | Главный риск |
|---|---|---|---|
| Playwright MCP | **ставить** — после выбора владельца, в локальном Cursor, `--isolated` | Node 20+, запись в MCP-конфиг, загрузка браузера | агент водит браузер; не цеплять к залогиненному профилю |
| Chrome DevTools MCP | **проверить позже** — когда появится своя веб-поверхность | Chrome + Node | дубль Playwright + живой профиль |
| Telegram Bot API / MTProto MCP | **отклонить** | токен или user-session, конфликт с long polling | 409 на проде, write от имени бота, сессия человека |
| Grafana MCP | **проверить позже** — когда Loki реально читают при красном гейте | service account + `--disable-write` | write-инструменты и дорогой LogQL |
| любой PostgreSQL MCP | **отклонить** | URI базы в конфиге агента | write или мёртвый archived-пакет |
| отдельный NATS MCP | **отклонить** | ещё один рантайм | нет официального сервера; есть `nats-tester` |

Follow-up в Linear не заводились. Если владелец выберет Playwright, задача на подключение — отдельная: конфиг клиента, `--isolated`, проверка на Windows и запрет `--extension`. Остальные итоги задач не порождают.

## Что проверено в этой сессии

- Registry API, npm view и GitHub API — только чтение.
- `https://api.githubcopilot.com/mcp/_ping` без токена: HTTP 401 и `WWW-Authenticate` на OAuth-protected resource. Эндпоинт жив, без секрета дальше не пускает. GitHub MCP в кандидаты не входил.
- `https://mcp.context7.com/mcp` GET: 405 и JSON-RPC «Method not allowed» — хост отвечает, сервер в кандидаты не входил.
- Локальные `:3000` и `:5432` закрыты.
- Ни один MCP-процесс не запускался.

Ограничение среды: Linear MCP в каталоге этой облачной сессии отсутствует, хотя владелец его подключал. Облачные агенты берут MCP из dashboard Integrations, не из локального `mcp.json`. Это не дефект кандидата, а разъезд сред контура.
