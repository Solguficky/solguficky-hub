# Decisions: ADR в docs/decisions

Где лежат принятые решения и как записать новое. Правила ведения — [docs/decisions/README.md](../decisions/README.md); здесь только адреса и порядок, которые скилл подставляет в свои шаги. Файл входит в [контракт проекта для флоу](README.md).

## Где лежат

- Каталог — `docs/decisions/`, файл на решение: `ADR-NNN-kebab-case-slug.md`.
- Индекс и статусы применимости — [docs/decisions/README.md](../decisions/README.md).
- Шаблон — [docs/decisions/template.md](../decisions/template.md).
- Перед записью читаются индекс, шаблон и последние два-три ADR.

## Когда нужна запись

- Решение уже принято владельцем. Выбор остаётся открытым — место вопроса RFC в `docs/rfcs/` или обсуждение, а не ADR.
- ADR нужен там, где видна цена и дорог откат. Решение, которое меняется правкой конфигурации или локальным рефакторингом, записывается в бриф сервиса или в задачу.
- Правило для code review живёт в `docs/standards/`, а не в ADR: нормативный текст в решении не дублируется.

## Как записать

- Черновик — `docs/decisions/ADR-draft-kebab-case-slug.md` с заголовком `# ADR-draft: <название решения>`. Номер при создании не берётся: пока ветка жива, свободный номер на базе — счётчик без блокировки.
- Номер присваивается непосредственно перед открытием pull request: сверь базу по [branching-and-pr.md](branching-and-pr.md#база), возьми следующий свободный номер по ней и по уже пронумерованным файлам ветки, переименуй файл, замени `ADR-draft` на `ADR-NNN` в заголовке и во всех ссылках, добавь строку в индекс.
- Решение заменяет старый ADR — обнови его применимость и ссылку на замену, не удаляя историю.
- Проверка — `just check-document-numbers`; уникальность номера держит `tools/docs/check-document-numbers.sh`.
- Скилл, на который опирается решение, называется путём в источнике правды (`.skillshare/skills/...`), а не в таргете.

## Что обновить вместе с записью

Принятый ADR не должен оставлять противоречащих утверждений в карте статусов. Пока номера нет, ссылка на черновик идёт по пути файла.

- [docs/architecture/decision-matrix.html](../architecture/decision-matrix.html)
- [docs/architecture/overview.md](../architecture/overview.md)
- [docs/architecture/first-slice.md](../architecture/first-slice.md)
- [docs/architecture/integration.md](../architecture/integration.md)
- бриф затронутого сервиса в [docs/services/](../services/README.md)
- [docs/product/overview.md](../product/overview.md) — если менялось продуктовое обещание или состав хранимых данных
- `docs/standards/` и `AGENTS.md` — если изменились их действующие правила
