# Telegram Bot

Первый TypeScript-компонент платформы. Принимает `/start` в личном чате, разрешает личность через Identity, показывает полученный из Meetups список видимых сходок и карточку сходки, включая переход по deep link `m_<uuid>`, и ведёт форму создания сходки, сохраняя каждый шаг в Meetups. Карточка показывает материалы в порядке Meetups: ссылки открываются по названию, файлы отправляются отдельной кнопкой. Администратор может привязать пересланное сообщение или Telegram-файл и удалить привязку после явного подтверждения. Список разделяет сходки с датой и без неё; пустой ответ и недоступность Meetups показаны разными экранами.

Сгенерированный контракт Identity лежит в `gen/` и в Git не хранится. Команда сборки сначала вызывает `buf generate`.

## Команды

Из корня репозитория:

```bash
just telegram-bot-tools
just telegram-bot-proto
just telegram-bot-build
just telegram-bot-typecheck
just telegram-bot-test
just telegram-bot-test-integration
just telegram-bot-lint
just telegram-bot-run
```

`just telegram-bot-tools` ставит зависимости через `npm ci`. Без него кодогенерация не находит `protoc-gen-es`.

`just telegram-bot-test` гоняет unit и component tests без Docker: наборы `*.integration.test.ts` исключены в `vitest.config.ts`. Их, с Testcontainers, гоняет `just telegram-bot-test-integration` по `vitest.integration.config.ts`; он входит в `just test-all` и CI, а в `just verify` — нет.

Токен бота — `TELEGRAM_BOT_TOKEN` (обязателен для процесса). Адрес Identity — `IDENTITY_GRPC_URL`, по умолчанию `http://127.0.0.1:50051`; адрес Meetups — `MEETUPS_GRPC_URL`, по умолчанию `http://127.0.0.1:50052`; адрес Notifications — `NOTIFICATIONS_GRPC_URL`, по умолчанию `http://127.0.0.1:50053`. Уровень лога — `TELEGRAM_BOT_LOG_LEVEL` (`debug` | `info` | `warn` | `error`, по умолчанию `info`). При заданном `OTEL_EXPORTER_OTLP_ENDPOINT` (его выставляет AppHost) записи уходят ещё и по OTLP в Structured logs dashboard, с тем же порогом; stdout остаётся.

Среда Telegram — `TELEGRAM_BOT_ENVIRONMENT`: без переменной процесс работает против продакшна, значение `test` уводит вызовы Bot API в [выделенную тестовую среду](../../docs/decisions/ADR-046-telegram-test-contour.md) на `https://api.telegram.org/bot<token>/test/`. Допустимые значения — `prod` и `test`; любое другое останавливает процесс, а не откатывает его к продакшну. Токен тестового бота выдаёт тестовый BotFather и с продакшн-токеном не взаимозаменяем.

Часовой пояс сообщества — `TELEGRAM_BOT_COMMUNITY_TIME_ZONE`, имя IANA вроде `Europe/Moscow`, обязательно. В нём карточка показывает назначенный момент публикации, который Meetups отдаёт мгновением UTC. Значение должно совпадать с `MEETUPS_COMMUNITY_TIME_ZONE`: AppHost задаёт обоим одной константой. Пустое или неизвестное имя останавливает процесс на старте.

Карточка по умолчанию отправляется Rich Message. Для операторского отката весь процесс переключается на плоский текст через `TELEGRAM_BOT_PRESENTATION=plain`; допустимые значения — `rich` и `plain`.

Тесты не ходят в Telegram и не требуют токена.

## Production-образ

```bash
just telegram-bot-image
just image-checks-test
```

Образ собирается по `Containerfile` из контекста корня репозитория: `buf generate` нужен `contracts/proto`. Что попадает в контекст, решает `Containerfile.dockerignore` — список разрешённого, поэтому `.env`, `node_modules` и `dist` рабочего дерева в сборку не доезжают. Стадий три: `build` генерирует код и собирает `dist`, `deps` ставит `npm ci --omit=dev`, финальная берёт из них только `dist`, production-зависимости и `package.json`: без него `dist/*.js` не читаются как модули ES.

- Каждая внешняя база, включая образ `bufbuild/buf`, закреплена по digest. `tools/image/check-containerfile.sh` роняет сборку на теге кодом `SOLG-IMG-TAG`, а на версии buf, которая разошлась с `BUF_VERSION` в `justfile`, — кодом `SOLG-IMG-BUF`: digest пишется только литералом, поэтому версия в Containerfile — проверяемая копия, а источник остаётся в `justfile`. Сменить базу — заменить digest целиком.
- База — `node:22-bookworm-slim`, а не distroless: `podman run --rm <образ> id` исполняет `id` из образа. Процесс идёт от uid 1000, команда стоит в CMD, точка входа базы сброшена. Запуск — прямой `node dist/src/main.js`, а не `npm start`: npm пишет в `~/.npm`.
- Токенов в образе нет: их выдаёт среда запуска, конфигурация идёт только переменными окружения. `tools/image/check-no-token.sh` ищет токен Bot API в каждом слое отдельно и в конфиге образа, куда попадают аргументы сборки, и находку печатает кодом `SOLG-IMG-TOKEN`.
- `tools/image/check-node-runtime.sh` проверяет, что в `/app` нет пакетов, которые `package-lock.json` помечает `"dev": true`, и нет исходников TypeScript. Список берётся из lockfile, а не из `devDependencies`: `@types/node` там же и production-зависимость `protobufjs`, и в образ едет законно.

`just image-checks-test` доказывает, что проверки ловят дефект, а не просто проходят: база по тегу, чужая версия buf, токен в слое, удалённый следующим слоем, и токен в аргументе сборки обязаны уронить их своими кодами. Токен-приманка генерируется на прогон и в репозиторий не попадает. Движок — `IMAGE_ENGINE`, по умолчанию podman; docker тоже работает.

Read-only rootfs проверен запуском с `--read-only --cap-drop=all --security-opt no-new-privileges`: процесс разбирает конфигурацию и доходит до подключения к NATS, на диск не пишет.

Публикацию делает только CI: `.github/workflows/image-telegram-bot.yml` вызывает переиспользуемый `image-publish.yml` веткой `containerfile`. В отличие от образов .NET, базы, токен и состав `/app` проверяются до публикации, и образ, который их не прошёл, в GHCR не попадает; uid проверяется общим шагом уже по опубликованному digest, и образ, не прошедший его, остаётся в GHCR без attestation. Pull request собирает и проверяет образ, ничего не записывая в реестр. Push в `develop` публикует `ghcr.io/solguficky/telegram-bot`, снимает SBOM, сканирует его в режиме report-only и выпускает attestation на registry digest; digest печатается в summary прогона. Происхождение проверяет та же команда, что и хост перед выкаткой:

```bash
gh attestation verify oci://ghcr.io/solguficky/telegram-bot@sha256:<digest> --repo Solguficky/solguficky-hub --signer-workflow Solguficky/solguficky-hub/.github/workflows/image-publish.yml --source-ref refs/heads/develop
```

Ссылку AppHost на этот `Containerfile` в режиме публикации добавляет PER-370: Aspire ищет Dockerfile только в каталоге приложения и с его контекстом.

## Раскладка

- `src/presentation/` — grammY, разбор update, Zod-схемы недоверенного ввода.
- `src/application/` — диспетчер и юзкейсы. Сюда не импортируют `grammy`.
- `src/identity/` — клиент `ResolveIdentity` через Connect gRPC.
- `src/meetups/` — клиент чтения сходок, команд формы и команд материалов через Connect gRPC.
