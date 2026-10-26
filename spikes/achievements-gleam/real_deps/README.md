# Gleam-корень с настоящими Elixir-зависимостями

Повтор Gleam-спайка после открытия `*.hex.pm`. Правила — чистое ядро на Gleam
(`src/achievements_real/rules.gleam`, `facts.gleam`), оболочка — Elixir в `src/`
(`achievements_real_shell.ex`): gnat `PullConsumer`, Ecto.Multi, grpc_server,
адаптер структур protobuf (protoc-gen-elixir) в типы Gleam. Сценарий тот же.

```sh
./run.sh sh -c 'mix local.hex --force && mix local.rebar --force'  # hex для mix, которым Gleam собирает deps
docker run -d --rm --name spike-pg --network host -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=achievements_real postgres:17
docker run -d --rm --name spike-nats --network host mirror.gcr.io/library/nats:2 -js
python ../publish_facts.py 1
SUB=real_deps ./run.sh sh -c 'SCENARIO=1 gleam run' &
python ../publish_facts.py 3       # после строки PHASE2 DONE
docker build --network host -t achievements-gleam-real -f Containerfile.real .   # из spikes/achievements-gleam
```

`evidence-actor-run.txt` — сценарий; `evidence-actor-run-debug-log.txt` — тот же
прогон на уровне логов по умолчанию (debug), где логгер выбросил отчёт о падении;
`evidence-boundary.txt` — неизвестный тег через границу Elixir→Gleam;
`evidence-grpc-health.txt` — health из образа без Elixir.
