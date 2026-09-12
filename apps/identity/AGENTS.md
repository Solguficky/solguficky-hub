# Identity

Go + gRPC. Устройство — [ADR-026](../../docs/decisions/ADR-026-identity-mvp-model-and-access.md), стек — [ADR-027](../../docs/decisions/ADR-027-identity-go-stack.md), первая выдача роли администратора в срезе — [ADR-036](../../docs/decisions/ADR-036-first-admin-via-service-endpoint.md), authentication служебного endpoint — [ADR-037](../../docs/decisions/ADR-037-identity-maintainer-shared-secret.md), ответственность — [бриф](../../docs/services/identity.md). Языковые правила — пак скиллов `golang-*`, точка входа `golang-how-to`. Состав полей лога — [standard](../../docs/standards/observability/logging.md).

- `cmd/identity/` только собирает процесс: env, логгер, листенер, сигналы, graceful shutdown. gRPC-поверхность туда не переезжает.
- `internal/server/` владеет gRPC: регистрация сервисов, interceptors, health, reflection и обработчики. Схема — `internal/migrations/`, изолированная база для тестов — `internal/testdb/`. Каталога `pkg/` нет: наружу сервис отдаёт только контракт.
- Миграции применяются до начала listen. Обработчик рассчитывает на готовую схему и сам её не проверяет.
- `gen/` пишет `buf generate` по `buf.gen.yaml`; каталог в `.gitignore`, руками не редактируется. Изменение контракта идёт через `proj-change-contract`.
- `.golangci.yml` работает в режиме `default: none` — линтер включается явным пунктом списка. Подавление правится в конфиге, а не `//nolint`: `nolintlint` требует и причину, и конкретный линтер.
- `paralleltest` включён, поэтому у нового теста должен быть `t.Parallel()`.
- Тест с базой берёт её через `internal/testdb`, а не поднимает свою. Локально без PostgreSQL он пропускается, в CI отсутствие базы — ошибка; это ветка по `GITHUB_ACTIONS` в `testdb`, а не забытый skip.
- Команды — `just identity-*`. Переменные окружения, ручной запуск и проверка через `grpcurl` — [README](README.md).
