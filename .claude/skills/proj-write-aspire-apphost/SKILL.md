---
name: proj-write-aspire-apphost
description: Писать и ревьюить Aspire AppHost этого репозитория: единый native resource graph, профили infra/core/full, Go-ресурсы, WithReference/WaitFor, health и живой gate. Использовать при правках infra/apphost, Topology.cs, Aspire hosting packages или локального запуска компонентов.
---

# Писать Aspire AppHost

Aspire — единственная локальная оркестрация проекта ([ADR-021](../../../docs/decisions/ADR-021-aspire-local-orchestration.md)). Профили и подтверждённые ограничения живут в [local-development.md](../../../docs/development/local-development.md), граница local и production — в [infrastructure.md](../../../docs/architecture/infrastructure.md). Здесь только форма AppHost-кода и его проверка.

## 1. Сверь версию и фактический API

До правки прочитай ближайший `AGENTS.md`, `infra/apphost/*.csproj`, `Program.cs`, `Topology.cs` и документацию компонента. Все `Aspire.AppHost.Sdk` и `Aspire.Hosting.*` packages держи на одной stable-линии. При обновлении сначала проверь актуальную стабильную версию и migration notes в официальных источниках.

Не переноси пример из skill или документации вслепую: сверь команду через `aspire --help`, integration через `aspire integration search`, незнакомый API через `aspire docs api search`. Версия CLI и версия AppHost могут различаться.

Для lifecycle используй `aspire-orchestration`, для состояния, health и логов — `aspire-monitoring`. Они не заменяют контур задачи и `just verify`.

## 2. Держи один граф

`Program.cs` остаётся читаемой картой ресурсов и связей. Настоящий граф — builders Aspire с `WithReference`, `WaitFor` и endpoint expressions.

- `Topology.cs` выбирает профиль и режим компонента, но не дублирует зависимости.
- Не заводи второй `ServiceGraph`, строковые `depends` или untyped registry поверх Aspire.
- Выноси setup в `Resources/*` только когда он скрывает детали адаптера: образ, команду запуска, environment mapping или health probe. Узел и его связи должны оставаться видимыми в composition root.
- Одно логическое имя используется для resource, профиля, `aspire wait`, тестов и документации.

Профиль отвечает на вопрос, какие компоненты принадлежат запуску. `infra` не запускает приложения; `core` поднимает компоненты первого вертикального среза; `full` — все зарегистрированные компоненты. Явный `Local | Container | Off` переопределяет профиль. Неизвестный профиль, режим или неподдерживаемая реализация падают с понятной ошибкой.

## 3. Подключай компонент через его контракт запуска

Используй first-party hosting integration текущей Aspire-линии, если она поддерживает реальный runtime компонента; иначе `AddExecutable` или `AddContainer` остаются честными native resources.

- Команда и working directory совпадают с ручным запуском компонента.
- Aspire назначает host port; процесс получает свой listen address через существующий environment contract.
- Connection string передаётся под ключом, который реально читает компонент. Не переименовывай его ради конвенции AppHost.
- `WithReference` передаёт данные, `WaitFor` задаёт readiness ordering. Одно не подменяет другое.
- Health проверяет штатный endpoint или протокол компонента. Состояние `Running` без readiness-проверки не считается `Healthy`.
- Логи идут через stdout/stderr и видны как logs ресурса; отдельный логовый sidecar ради dashboard не добавляется.

## 4. Проверяй два слоя

Сначала механика:

1. restore/build AppHost и затронутого компонента;
2. неизвестный профиль и неподдерживаемый mode дают ожидаемый отказ;
3. `just verify` остаётся зелёным.

Затем живой gate. В worktree запускай точный AppHost через agent-safe lifecycle из `aspire-orchestration`, дождись каждого ресурса через `aspire wait`, проверь graph/health через `aspire describe` и логи через `aspire-monitoring`. Endpoint бери из Aspire, затем выполни тот же протокольный вызов, что при ручном запуске. Профили `infra` и `full` проверяются отдельными запусками, после каждого AppHost штатно останавливается.

Документация меняет статус «не проверено» только после этого живого gate. Зелёная сборка без контейнеров его не заменяет.

## Границы

Skill не проектирует сервисы, production deployment, MCP или межсервисные контракты. Новый ресурс добавляется только в срезе своей Linear-задачи. Compose удаляется лишь когда это прямо разрешено задачей и подтверждён заменяющий путь.

Изменение готово, когда `Program.cs` читается как один native graph, профиль не хранит второй список зависимостей, каждый локальный ресурс достигает `Healthy`, а документированные команды повторяют фактически выполненный gate.
