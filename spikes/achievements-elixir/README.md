# Спайк: чистый Elixir для Achievements (PER-750)

Одноразовый код решения о стеке, в develop не идёт. Тот же сценарий, что в
`spike/achievements-gleam`, но на настоящих gnat 1.18.1, Ecto 3.14 / Postgrex
0.22.4, protobuf 0.17.1 (protoc-gen-elixir) и elixir-grpc 1.0.5 (`grpc_server`).

## Устройство

- `lib/achievements/application.ex` — дерево: Repo, `Gnat.ConnectionSupervisor`,
  `DynamicSupervisor` акторов, gRPC-сервер с `grpc.health.v1.Health/Check`.
- `lib/achievements/actor.ex` — актор ачивки на `Gnat.Jetstream.PullConsumer`:
  эфемерный consumer с `opt_start_seq` = курсор + 1, `max_ack_pending: 1`;
  одна транзакция `Ecto.Multi` на факт (processed, правило, grants + outbox,
  курсор), ack после commit.
- `lib/achievements/rules/rules.ex` — четыре ачивки поведением `Achievement`.
- `lib/achievements/relay.ex` — релей outbox с водяным знаком (ADR-077 п.8).
- `priv/repo/migrations` — схема: уникальность пары и одиночки — индексы PG.
- `lib/achievements/proto` — код protoc-gen-elixir из неизменённых proto.

## Как воспроизвести

```sh
./run.sh sh -c 'mix local.hex --force && mix local.rebar --force'   # тулбокс spike-tb из Gleam-спайка
docker run -d --rm --name spike-pg --network host -e POSTGRES_PASSWORD=spike postgres:17
docker run -d --rm --name spike-nats --network host mirror.gcr.io/library/nats:2 -js
SUB=achievements ./run.sh sh -c 'mix deps.get && mix ecto.create && mix ecto.migrate'
python publish_facts.py 1
SUB=achievements ./run.sh mix run -e 'Achievements.Scenario.run()' &
python publish_facts.py 3            # после строки PHASE2 DONE
docker build --network host -t achievements-elixir -f Containerfile .
docker run --rm --network host -e START_ACTORS=1 achievements-elixir
```

`evidence-*.txt` — выводы прогонов.
