# Continuous Integration

> **Статус:** Current, verification pending. Workflow существует, но успешный удалённый прогон после последних изменений не подтверждён.

Current workflow: `.github/workflows/ci.yml`.

Workflow собирает, тестирует и линтит Identity на изменение `apps/identity/**`, контракта, `justfile` и самого workflow. Джоба `identity` передаёт `github.token` в `buf-setup-action`: без него установка `buf` бьёт в GitHub API без авторизации и на hosted runner падает по rate limit.

Известные gaps:

- Aspire AppHost требует отдельного restore/build/smoke-test gate;
- `buf lint` и compatibility check Protobuf ещё не внедрены.

## Проверки репозитория

Джоба `repo-hygiene` запускает `tools/skillshare/check-generated.sh`. Скрипт сверяет собственные `proj-` skills и закоммиченный пак `golang/` с обоими таргетами, доступные локально источники внешних skills с их таргетами, общие внешние skills между `.claude/skills/` и `.agents/skills/`, а также agents и commands с их источниками в `.skillshare/`. Локально запускается командой `just check-agent-tools`.

Источники внешних skills из Skillshare не коммитятся, поэтому в CI сверка этих источников ничего не находит и пропускается: удалённо остаётся сравнение закоммиченных таргетов между собой плюс сверка пака `golang/`. Локальный прогон строже удалённого намеренно — рассинхрон источника ловится до push, а не в review.

Проверка не полагается на `skillshare diff` для native agents в режиме `copy`: Skillshare 0.20.x не создаёт для них manifest и помечает даже идентичную копию как local override. Фактическая синхронность этого файла проверяется по содержимому, с точностью до перевода строки: таргет — копия источника, и различаться они могут только тем, как Git выполнил checkout.

[Формат сообщений коммитов](../standards/git/commit-messages.md) в CI не проверяется: стандарт распространяется на обычные коммиты, а в `main` при squash-merge попадает заголовок PR, к которому он не применяется. Контроль формата остаётся локальным хуком.

Целевой минимум для документационных и контрактных изменений:

1. Markdown links не содержат битых активных относительных ссылок.
2. Protobuf change запускает codegen/build/tests всех потребителей.
3. Breaking changes проверяются выбранным compatibility tooling.
4. Current код не выпадает из build незаметно.

Конкретные задачи и их прогресс ведутся в Linear.

## Презентация аукционного модуля

Workflow `.github/workflows/deploy-auction-slides.yml` публикует автономную историческую презентацию на [Netlify](https://solguficky-auction-module-slides.netlify.app/) после изменения HTML-файла в `develop`. Его также можно запустить вручную через `workflow_dispatch`.

Для работы workflow в настройках GitHub repository должны быть заданы:

- secret `NETLIFY_AUTH_TOKEN` — персональный Netlify access token с доступом к проекту;
- variable `NETLIFY_AUCTION_SLIDES_SITE_ID` — Netlify Project ID сайта `solguficky-auction-module-slides`.

Workflow собирает отдельный каталог, копирует презентацию в `index.html` и выполняет production deploy через зафиксированную версию Netlify CLI. Токен и Project ID не хранятся в Git.

Если Netlify-проект уже связан с Git-репозиторием и сам выполняет continuous deployment, перед включением GitHub workflow нужно оставить только один production-механизм. Иначе один push может породить два независимых deploy.
