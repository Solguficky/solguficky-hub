# Документация Solguficky Hub

`docs/` хранит устойчивый контекст проекта: продуктовые границы, архитектуру, сервисные briefs, стандарты и историю решений. Milestones, приоритеты, задачи и прогресс ведутся в Linear.

## С чего начать

1. [Продукт и границы MVP](product/overview.md)
2. [Архитектурный обзор Current / MVP / Future / Legacy](architecture/overview.md)
3. [Карта сервисов](services/README.md)
4. [Индекс архитектурных решений](decisions/README.md)
5. [Процесс проектирования](development/design-process.md)

## Разделы

| Раздел | Назначение |
|---|---|
| [product/](product/) | Что и для кого строим, границы MVP и непринятые идеи |
| [architecture/](architecture/) | Как устроена система и взаимодействуют компоненты |
| [services/](services/) | Ответственность, состояние и открытые вопросы компонентов |
| [standards/](standards/) | Нормативы реализации и code review — «делай так» |
| [rfcs/](rfcs/) | Предложения и варианты до принятия решения |
| [decisions/](decisions/) | Принятые архитектурные решения и причины |
| [development/](development/) | Рабочий процесс, local development и CI |
| [design/](design/) | Макеты и UI-решения |
| [archive/](archive/) | Исторические материалы, не являющиеся источником правды |

Правила написания документов — в [STYLE.md](STYLE.md).

## Источники правды

| Информация | Источник |
|---|---|
| Цель, принципы и scope | [product/overview.md](product/overview.md) |
| Current / MVP / Future / Legacy | [architecture/overview.md](architecture/overview.md) и service briefs |
| Принятые технические решения | [decisions/](decisions/) |
| Нормы реализации и review | [standards/](standards/) |
| Wire-контракты | `contracts/proto/` |
| Integration catalog и contract governance | [architecture/integration.md](architecture/integration.md) |
| Сервисные границы и открытые вопросы | [services/](services/) |
| Local development и процесс | [development/](development/) |
| Инструкции агентам | корневой и вложенные `AGENTS.md` |
| Приоритеты, milestones, задачи и прогресс | Linear |

При расхождении фактов код, конфигурация, тесты и миграции имеют приоритет для Current; действующие ADR — для принятой архитектуры. Архив используется только для восстановления истории.

## Статусы

Временной слой:

- **Current** — существует сейчас;
- **MVP** — требуется для первой живой сходки через бота;
- **Future** — направление после MVP без текущего обязательства;
- **Legacy** — существующий код или дизайн вне активного направления.

Зрелость решения:

- **Accepted** — принято владельцем;
- **Proposed** — есть предпочтение, но решение ещё утверждается;
- **Open** — варианты исследуются;
- **Superseded** — решение больше не определяет направление.

Статус документа:

- **Canonical** — действующий источник правила или описания;
- **Draft** — материал для обсуждения;
- **Historical** — архивный срез.

## RFC, ADR и standard

- **RFC** помогает обсудить варианты до решения.
- **ADR** сохраняет принятое решение и ответ на вопрос «почему».
- **Standard** задаёт действующее проверяемое правило реализации.

Принятый RFC может породить ADR, standard, оба документа либо только изменение кода. Не каждое изменение требует всех трёх артефактов.

## Что не хранится в `docs/`

- копия Linear backlog и статусов задач;
- отдельный Git-roadmap;
- generated Protobuf types;
- подробные команды конкретного сервиса — они живут в его README;
- инструкции конкретному AI-инструменту — они живут в skills и `AGENTS.md`.

Полный переходный срез, из которого создана текущая структура, сохранён как [исторический snapshot](archive/snapshots/project-context-2026-08-06.md).
