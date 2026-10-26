# Спайк: Rust для Achievements (PER-750)

Одноразовый код решения о стеке, в develop не идёт. Тот же сценарий, что у
Gleam-спайка (`spikes/achievements-gleam` на ветке `spike/achievements-gleam`):
те же факты, сбои и фазы, чтобы результаты сравнивались построчно.

Стек: prost 0.14 + protox 0.9 (кодоген без protoc), tokio 1.54, async-nats 0.46
(JetStream pull consumer), sqlx 0.8 (PostgreSQL, запросы без compile-time
макросов), tonic 0.14 + tonic-health. Rust 1.97.

## Как воспроизвести

```sh
docker run -d --rm --name rust-nats --network host mirror.gcr.io/library/nats:2 -js -p 4223
docker run -d --rm --name rust-pg --network host -e POSTGRES_PASSWORD=spike postgres:17 -p 5433
python -m grpc_tools.protoc -I../../contracts/proto --python_out=pygen \
  auction/v1/auction.proto auction/v1/auction_events.proto
python make_fixtures.py                 # эталонные байты фактов (копия из Gleam-спайка)
cargo run --bin decode_check            # пункт 1 -> evidence-decode.txt
cp exhaustive/missing_variant.rs examples/ && cargo build --example missing_variant  # E0004
cargo build
PY=python ./run.sh scenario             # пункт 2, один процесс -> evidence-actor-run.txt
PY=python ./run.sh process-kill         # kill -9 процесса и перезапуск -> evidence-process-kill.txt
docker build --network host --build-arg HTTPS_PROXY --secret id=ca,src=/root/.ccr/ca-bundle.crt \
  -f spikes/achievements-rust/Containerfile -t achievements-rust ../..   # пункт 4
```

`publish_facts.py` — копия Gleam-спайка с портом 4223: 40 фактов и 2 повтора
релея с тем же `event_id` под другим `Nats-Msg-Id`; `publish_facts.py 3` — ещё 6.

## Что где

- `build.rs` — protox разбирает неизменённые `contracts/proto/auction/v1/{auction,auction_events}.proto`, prost-build генерирует типы.
- `src/facts.rs` — разбор факта по subject, `bidder()` (`state.trading.leader_id`), `payer()`.
- `src/rules.rs` — четыре ачивки; правило исполняется внутри транзакции факта.
- `src/store.rs` — схема (processed PK, rule_state, `grant_` с UNIQUE(achievement, subject) и частичным UNIQUE(achievement) WHERE single, outbox, cursor), транзакция и релей outbox с водяным знаком min(cursor).
- `src/actor.rs` — актор = tokio-задача: эфемерный pull consumer `by_start_sequence` с курсора+1, ack explicit, `max_ack_pending 1`, одна транзакция на факт, `double_ack` после commit; наблюдатель держит `JoinHandle` и перезапускает задачу после паники, abort или ошибки.
- `src/bin/scenario.rs` — сценарий фаз 1–3 с инъекцией сбоев; `src/bin/serve.rs` — процесс сервиса (акторы, релей, gRPC health на :50071); `src/bin/health_check.rs` — клиент health.
- `evidence-*.txt` — выводы прогонов.
