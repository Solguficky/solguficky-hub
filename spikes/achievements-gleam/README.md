# Спайк: Gleam для Achievements (PER-750)

Одноразовый код решения о стеке. В develop не идёт. Отчёт — документ Linear
«Спайк: Gleam для Achievements» у PER-750.

## Как воспроизвести

Нужны Docker и сеть до github.com и Docker Hub (зеркало `mirror.gcr.io`).

```sh
# тулбокс: Elixir 1.20.4 / OTP 28 + Gleam 1.19.2 (бинарь из релиза GitHub рядом)
docker build -t spike-tb -f- . <<'X'
FROM mirror.gcr.io/library/elixir:1.20-otp-28
COPY gleam /usr/local/bin/gleam
X
docker run -d --rm --name spike-nats --network host mirror.gcr.io/library/nats:2 -js
python -m grpc_tools.protoc -I../../contracts/proto --python_out=pygen \
  auction/v1/auction.proto auction/v1/auction_events.proto
python make_fixtures.py              # эталонные байты фактов
SUB=achievements_spike ./run.sh gleam run -m decode_check
python publish_facts.py 1            # 40 фактов + 2 повтора релея
SUB=achievements_spike ./run.sh gleam run &   # сценарий актора
python publish_facts.py 3            # после строки PHASE2 DONE
docker build --network host -t achievements-spike -f Containerfile .
```

## Что где

- `achievements_spike/gleam.toml` — все Gleam-зависимости из git: repo.hex.pm
  закрыт политикой сети среды.
- `achievements_spike/src/achievements_spike/wire.gleam`, `facts.gleam` —
  ручной слой Protobuf вместо protozoa; `patch_proto.py` — правки, без которых
  protozoa 2.0.3 не генерирует код, и всё равно не генерирует компилируемый.
- `achievements_spike/src/achievements_spike/achievement.gleam` — актор ачивки;
  `rules.gleam` — четыре ачивки; `store.gleam` + `spike_store_ffi.erl` —
  транзакция факта на Mnesia вместо PostgreSQL (pog тянет pgo с hex);
  `nats.gleam` + `spike_nats_ffi.erl` — минимальный клиент JetStream вместо gnat.
- `achievements_spike/src/spike_bridge.ex` — Elixir-модуль в Gleam-корне.
- `elixir_control/collector.ex` — контроль на Elixir, не собирался (hex).
- `elixir_typecheck/occasion.ex` — что Elixir 1.20 говорит о пропущенном варианте.
- `evidence-*.txt` — выводы прогонов.
