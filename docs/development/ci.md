# Continuous Integration

> **Статус:** Current, verification pending. Workflow существует, но успешный удалённый прогон после последних изменений не подтверждён.

Current workflow: `.github/workflows/ci.yml`.

Workflow собирает, тестирует и линтит Identity на изменение `apps/identity/**`, контракта, `justfile` и самого workflow. Джоба `telegram-bot` делает typecheck, lint, test и build TypeScript-скелета. Джоба `meetups` проверяет, что контрактный проект остаётся generated-only, прогоняет Fantomas, собирает решение и запускает оба тестовых проекта на изменение контракта, `apps/meetups/**`, `shared/dotnet/**`, `tools/meetups/**`, `justfile`, `global.json` и самого workflow. Тесты схемы поднимают PostgreSQL через Testcontainers, отдельного sidecar в джобе нет. `shared/dotnet/**` в её фильтре появился вместе с первым потребителем ServiceDefaults: без него правка обвязки могла бы уронить сборку сервиса мимо проверки. Джоба `identity` передаёт `github.token` в `buf-setup-action`: без него установка `buf` бьёт в GitHub API без авторизации и на hosted runner падает по rate limit.

Джоба `apphost` компилирует `infra/apphost/AppHost.csproj` на изменение `infra/apphost/**`, `shared/dotnet/**`, `apps/meetups/**`, `contracts/proto/**`, `justfile` и самого workflow. Два последних пути в фильтре потому, что AppHost ссылается на `Meetups.fsproj` ради типизованного `Projects.Meetups`: его сборка теперь тянет за собой сервис и его кодогенерацию. SDK она берёт из корневого `global.json`: AppHost таргетит `net10.0`, и `Aspire.AppHost.Sdk` работает на той же линии. Без этой джобы правка графа или setup-а ресурса, которая не собирается, ловилась бы только локальным `just verify`.

Кроме `push` в `main` и pull request workflow принимает `workflow_dispatch` — ручной запуск на случай, когда push не создал прогон сам, например когда ветку двигал GitHub App. У ручного запуска нет базы для сравнения путей, поэтому джоба `changes` на нём пропускается, а `identity`, `meetups`, `telegram-bot` и `apphost` запускаются по `github.event_name` безусловно. Кнопка Run workflow в UI появляется только когда триггер есть в `ci.yml` ветки по умолчанию, но запуск через REST API (`POST /actions/workflows/ci.yml/dispatches` с нужным `ref`) работает и с ветки, где триггер уже добавлен, — так этот прогон и был получен.

Известные gaps:

- живой прогон Aspire (smoke-test поднятой топологии) в CI отсутствует: джоба `apphost` подтверждает только компиляцию;
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

## Автономные страницы аукциона

Workflow `.github/workflows/deploy-auction-slides.yml` публикует на [Netlify](https://solguficky-auction-module-slides.netlify.app/) две автономные страницы после изменения любой из них в `develop`. Его также можно запустить вручную через `workflow_dispatch`.

| Страница | Источник | Адрес |
|---|---|---|
| Историческая презентация модуля | [auction-module-presentation.html](../archive/services/auction-module-presentation.html) | корень сайта |
| Версия RFC-007 для админа | [RFC-007-auction-for-admins.html](../rfcs/RFC-007-auction-for-admins.html) | `/rfc-007` |

Для работы workflow в настройках GitHub repository должны быть заданы:

- secret `NETLIFY_AUTH_TOKEN` — персональный Netlify access token с доступом к проекту;
- variable `NETLIFY_AUCTION_SLIDES_SITE_ID` — Netlify Project ID сайта `solguficky-auction-module-slides`.

Workflow собирает отдельный каталог, копирует в него обе страницы и выполняет production deploy через зафиксированную версию Netlify CLI. Токен и Project ID не хранятся в Git.

Обе страницы копируются каждый прогон, и `paths` перечисляет оба источника намеренно: `deploy --prod --dir` заменяет содержимое сайта целиком, а не дополняет его. Прогон, собравший каталог из одного файла, увёл бы вторую страницу в 404. По той же причине новая страница на этом сайте добавляется правкой обоих мест сразу, а не одного.

Если Netlify-проект уже связан с Git-репозиторием и сам выполняет continuous deployment, перед включением GitHub workflow нужно оставить только один production-механизм. Иначе один push может породить два независимых deploy.
