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

## Раскладка

- `src/presentation/` — grammY, разбор update, Zod-схемы недоверенного ввода.
- `src/application/` — диспетчер и юзкейсы. Сюда не импортируют `grammy`.
- `src/identity/` — клиент `ResolveIdentity` через Connect gRPC.
- `src/meetups/` — клиент чтения сходок, команд формы и команд материалов через Connect gRPC.
