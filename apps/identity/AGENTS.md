# Identity

Go + gRPC. Устройство — [ADR-026](../../docs/decisions/ADR-026-identity-mvp-model-and-access.md), стек — [ADR-027](../../docs/decisions/ADR-027-identity-go-stack.md), первая выдача роли администратора в срезе — [ADR-036](../../docs/decisions/ADR-036-first-admin-via-service-endpoint.md), authentication служебного endpoint — [ADR-037](../../docs/decisions/ADR-037-identity-maintainer-shared-secret.md), ответственность — [бриф](../../docs/services/identity.md). Языковые правила — пак скиллов `golang-*`, точка входа `golang-how-to`. Состав полей лога — [standard](../../docs/standards/observability/logging.md).

- `cmd/identity/` только собирает процесс: env, логгер, листенер, сигналы, graceful shutdown. gRPC-поверхность туда не переезжает.
- `internal/server/` владеет gRPC: регистрация сервисов, interceptors, health, reflection и обработчики. Схема — `internal/migrations/`, изолированная база для тестов — `internal/testdb/`. Каталога `pkg/` нет: наружу сервис отдаёт только контракт.
- Миграции применяются до начала listen. Обработчик рассчитывает на готовую схему и сам её не проверяет.
- `gen/` пишет `buf generate` по `buf.gen.yaml`; каталог в `.gitignore`, руками не редактируется. Изменение контракта идёт через `proj-change-contract`.
- `.golangci.yml` работает в режиме `default: none` — линтер включается явным пунктом списка. Подавление правится в конфиге, а не `//nolint`: `nolintlint` требует и причину, и конкретный линтер.
- `paralleltest` включён, поэтому у нового теста должен быть `t.Parallel()`.
- Изменение состояния доступа — регистрация, выдача и отзыв роли, блокировка и её снятие — пишет событие `outbox.Append` той же транзакцией. Без события транзакция не коммитится: это держит триггер `ID006`, а не ревью. `internal/outbox` владеет очередью, `internal/relay` публикует её в JetStream.
- Фикстура, которая меняет состояние доступа прямым SQL, берёт `testdb.ExecAnnounced`. Состояние, которое сервис сам создать не может, — роль у заблокированного, профиль, созданный заблокированным, — создаётся `testdb.ExecBypassingShields`, и только оно.
- Тест с базой берёт её через `internal/testdb`, а не поднимает свою. Без доступного PostgreSQL прогон падает и локально, и в CI — `testdb` пропуска не даёт: пропуск неотличим от прохождения ([PER-241](https://linear.app/anticnvm/issue/per-241)).
- Тест с базой живёт в файле `*_integration_test.go` со строкой `//go:build integration` первой: уровень выбирается тегом, а не `t.Skip` или `testing.Short()`. `just identity-test` и `verify` компилируют только unit-файлы, `just identity-test-integration` и CI — всё под тегом. Помощник, которым пользуются только тегированные файлы, сам лежит в тегированном файле, иначе `unused` в сборке без тега роняет линт ([PER-269](https://linear.app/anticnvm/issue/per-269)).
- Команды — `just identity-*`. Переменные окружения, ручной запуск и проверка через `grpcurl` — [README](README.md).
