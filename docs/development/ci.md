# Continuous Integration

> **Статус:** Current, verification pending. Workflow существует, но успешный удалённый прогон после последних изменений не подтверждён.

Current workflow: `.github/workflows/ci.yml`.

Известные gaps:

- workflow устанавливает .NET 8 для сервисов, переведённых на net10;
- изменение `contracts/proto/` должно проверять всех producers и consumers, а не только проекты, выбранные обычными path filters;
- оставленные Legacy-сервисы должны продолжать собираться до согласованного удаления;
- Aspire AppHost требует отдельного restore/build/smoke-test gate;
- compatibility check Protobuf ещё не внедрён.

Целевой минимум для документационных и контрактных изменений:

1. Markdown links не содержат битых активных относительных ссылок.
2. Protobuf change запускает codegen/build/tests всех потребителей.
3. Breaking changes проверяются выбранным compatibility tooling.
4. Current и оставшийся Legacy код не выпадают из build незаметно.

Конкретные задачи и их прогресс ведутся в Linear.

## Презентация аукционного модуля

Workflow `.github/workflows/deploy-auction-slides.yml` публикует автономную историческую презентацию на [Netlify](https://solguficky-auction-module-slides.netlify.app/) после изменения HTML-файла в `develop`. Его также можно запустить вручную через `workflow_dispatch`.

Для работы workflow в настройках GitHub repository должны быть заданы:

- secret `NETLIFY_AUTH_TOKEN` — персональный Netlify access token с доступом к проекту;
- variable `NETLIFY_AUCTION_SLIDES_SITE_ID` — Netlify Project ID сайта `solguficky-auction-module-slides`.

Workflow собирает отдельный каталог, копирует презентацию в `index.html` и выполняет production deploy через зафиксированную версию Netlify CLI. Токен и Project ID не хранятся в Git.

Если Netlify-проект уже связан с Git-репозиторием и сам выполняет continuous deployment, перед включением GitHub workflow нужно оставить только один production-механизм. Иначе один push может породить два независимых deploy.
