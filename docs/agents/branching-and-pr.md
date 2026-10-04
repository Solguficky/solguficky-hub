# Branching and pull request: gitflow, GitHub

От чего ветвится работа и в какой форме она сдаётся. Правила — [standards/git/branching.md](../standards/git/branching.md) и [standards/git/commit-messages.md](../standards/git/commit-messages.md); здесь только значения и команды, которые скилл подставляет в свои шаги. Файл входит в [контракт проекта для флоу](README.md).

## База

- База всей разработки — `origin/develop`. `main` хранит состояние прода, и агент его не трогает: ни коммитом, ни мержем, ни переключением.
- Сверка базы: `git fetch origin`, затем `git log --oneline HEAD..origin/develop`. Вывод непуст — база ушла вперёд. `origin/develop` — общий ref всех рабочих деревьев, и его двигает любой `fetch` соседней сессии, поэтому сверка на входе в контур не защищает сдачу.
- Правки ещё нет — обнови базу сразу. Правка есть — сначала зафиксируй её коммитом, потом rebase на `origin/develop`. `git reset --soft origin/develop` под грязным индексом переносит входящие изменения в индекс в обратную сторону.
- Дифф ветки: `git diff origin/develop...HEAD` — три точки, сравнение с merge-base; коммиты ветки — `git log origin/develop..HEAD --oneline`.

## Имя ветки

- `feature/PER-N`: префикс и идентификатор задачи в верхнем регистре, без слага. Создаётся командой `git switch -c feature/PER-N origin/develop`.
- Имя из поля `gitBranchName` трекера и кнопки «Copy git branch name» не берётся: оно в нижнем регистре. Дерево от приложения приезжает именно на нём — переименуй: `git branch -M feature/PER-N`. Без `-M` смена одного регистра на Windows падает с `already exists`.
- Имя ветки отвечает на вопрос «над чем работает это дерево» и подсказывает, где искать спецификацию: `feature/PER-N` даёт задачу `PER-N`. Занята ли задача, оно не говорит.
- На `main` и `develop` работа не ведётся: оказался на них — сначала ветка.
- Вторая задача берёт отдельное рабочее дерево, а не переключение ветки; правила деревьев — в нормативе.

## Коммит

- Формат заголовка — [commit-messages.md](../standards/git/commit-messages.md): одна строка Conventional Commits, без тела. Второй `-m` создаёт тело — его быть не должно.
- Идентификатора задачи в заголовке коммита нет.
- Формат проверяет локальный хук `commit-msg`; коммит записывается через skill `proj-write-commit`.

## Pull request

- Хостинг — GitHub, инструмент — `gh`. База pull request — `develop`.
- Заголовок PR задачи — `[PER-N] Название задачи из трекера` дословно. Тело — три раздела: `## Что и зачем`, `## Отклонения от плана`, `## Осталось открытым`. Форма и примеры — в нормативе.
- Проверка перед созданием: `gh pr view --json isDraft,url`. Второй `gh pr create` на ту же ветку отказывает с `a pull request for branch ... already exists`.
- Создание: `git push -u origin feature/PER-N`, затем `gh pr create --base develop --title "[PER-N] Название задачи" --body-file <файл>`.
- Чекпоинт на вопросе — тот же вызов с `--draft`: draft несёт вопрос, а не запрос ревью.
- Draft уже открыт — `git push`, `gh pr edit --title "[PER-N] Название задачи" --body-file <файл>`, `gh pr ready`.
- Тело передаётся файлом (`--body-file`): многострочный `--body` в PowerShell приезжает склеенным.
- Вливается pull request в `develop` через squash; ревью и мерж выполняет владелец.

## Ревью pull request

- CodeRabbit агент не вызывает: его запускает владелец комментарием ([AGENTS.md](../../AGENTS.md)). Его находки разбираются после сдачи.
- Судьба находки ревью, которую исполнитель не чинит, — отложена, оспорена или вынесена в задачу; каждая названа в разделе «Осталось открытым». Правило — в нормативе.

## Норматив

- [standards/git/branching.md](../standards/git/branching.md) — ветки, рабочие деревья, заголовок и тело pull request.
- [standards/git/commit-messages.md](../standards/git/commit-messages.md) — заголовок коммита.
