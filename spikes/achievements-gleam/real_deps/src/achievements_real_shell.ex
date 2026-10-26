# Elixir-оболочка Gleam-ядра: PostgreSQL (Ecto), NATS JetStream (gnat), gRPC
# (grpc_server) и адаптер структур protobuf в типы Gleam. Правила — в
# achievements_real/rules.gleam, оболочка их только исполняет в транзакции.

defmodule AchievementsReal.Repo do
  use Ecto.Repo, otp_app: :achievements_real, adapter: Ecto.Adapters.Postgres
end

defmodule AchievementsReal.Facts do
  @moduledoc """
  Структура protobuf -> значение типа Fact Gleam. Это граница без проверки
  типов: Gleam доверяет форме кортежа, а Elixir её не проверяет.
  """
  alias Auction.V1.{InvoiceEvent, LotEvent}

  def to_gleam("events.auction.invoice_paid", body) do
    e = InvoiceEvent.decode(body)
    {:invoice, e.event_id, e.state.winner_id, occasion(e.occasion, :unknown_invoice_occasion)}
  end

  def to_gleam("events.auction.bid_placed", body) do
    e = LotEvent.decode(body)

    leader =
      case e.state.status do
        {:trading, %{leader_id: l}} when is_binary(l) -> {:some, l}
        _ -> :none
      end

    {:lot, e.event_id, occasion(e.occasion, :unknown_lot_occasion), leader}
  end

  def to_gleam(_subject, _body), do: :ignored

  # Тег oneof Elixir protobuf совпадает с атомом конструктора Gleam.
  defp occasion(nil, unknown), do: unknown
  defp occasion({tag, _}, _unknown), do: tag

  def event_id({kind, id, _, _}) when kind in [:invoice, :lot], do: id
  def event_id(:ignored), do: nil
end

defmodule AchievementsReal.Actor do
  @moduledoc "Актор ачивки: эфемерный consumer от курсора, одна транзакция на факт, ack после commit."
  use Gnat.Jetstream.PullConsumer
  import Ecto.Query
  alias AchievementsReal.{Facts, Repo}
  alias Ecto.Multi
  require Logger

  @stream "ACH_FACTS"
  def stream, do: @stream

  def child_spec(code),
    do: %{id: {__MODULE__, code}, start: {__MODULE__, :start_link, [code]}, restart: :permanent}

  def start_link(code), do: Gnat.Jetstream.PullConsumer.start_link(__MODULE__, code)

  def cursor(code),
    do: Repo.one(from c in "cursors", where: c.achievement == ^code, select: c.seq) || 0

  @impl true
  def init(code) do
    {:ok, achievement} = :achievements_real@rules.find(code)
    Process.register(self(), :"ach_#{code}")
    from = cursor(code) + 1
    Logger.info("#{code}: start from seq #{from}")

    {:ok, achievement,
     connection_name: :gnat,
     consumer: %Gnat.Jetstream.API.Consumer{
       stream_name: @stream,
       deliver_policy: :by_start_sequence,
       opt_start_seq: from,
       ack_policy: :explicit,
       max_ack_pending: 1
     }}
  end

  @impl true
  def handle_message(%{topic: subject, body: body} = message, achievement) do
    {:achievement, code, _title, _single, _rule} = achievement
    {:ok, %{stream_seq: seq}} = Gnat.Jetstream.API.Message.metadata(message)
    Process.sleep(15)
    fact = Facts.to_gleam(subject, body)
    {:ok, %{grants: granted}} = Repo.transaction(transaction(achievement, fact, seq))

    if take_crash(code, seq, :after_commit), do: raise("#{code}: injected crash after commit, before ack")
    for s <- granted, do: Logger.info("#{code}: granted #{s} at seq #{seq}")
    {:ack, achievement}
  end

  defp transaction({:achievement, code, _title, single, rule}, fact, seq) do
    Multi.new()
    |> Multi.run(:grants, fn repo, _ ->
      with id when is_binary(id) <- Facts.event_id(fact),
           {1, _} <- repo.insert_all("processed", [%{achievement: code, event_id: id}], on_conflict: :nothing) do
        reads =
          {:reads,
           fn s -> repo.one(from r in "rule_state", where: r.achievement == ^code and r.subject == ^s, select: r.count) || 0 end,
           fn -> repo.exists?(from g in "grants", where: g.achievement == ^code) end}

        {:decision, grants, counts} = rule.(fact, reads)

        for {s, n} <- counts do
          repo.insert_all("rule_state", [%{achievement: code, subject: s, count: n}],
            on_conflict: {:replace, [:count]}, conflict_target: [:achievement, :subject])
        end

        subjects =
          grants
          |> Enum.uniq()
          |> Enum.reject(&repo.exists?(from g in "grants", where: g.achievement == ^code and g.subject == ^&1))

        rows = for s <- subjects, do: %{achievement: code, subject: s, occasion_event: id, seq: seq}
        repo.insert_all("grants", Enum.map(rows, &Map.put(&1, :single, single)))
        repo.insert_all("outbox", rows)
        {:ok, subjects}
      else
        _ -> {:ok, []}
      end
    end)
    |> Multi.insert_all(:cursor, "cursors", [%{achievement: code, seq: seq}],
      on_conflict: {:replace, [:seq]}, conflict_target: :achievement)
    |> Multi.run(:crash, fn _, _ ->
      if take_crash(code, seq, :before_commit), do: raise("#{code}: injected crash inside transaction"), else: {:ok, nil}
    end)
  end

  def arm_crash(code, seq, where), do: :persistent_term.put({:crash, code, seq, where}, true)

  defp take_crash(code, seq, where),
    do: :persistent_term.get({:crash, code, seq, where}, false) and :persistent_term.erase({:crash, code, seq, where})
end

defmodule AchievementsReal.Relay do
  @moduledoc "Релей outbox с водяным знаком стрима (предложение к ADR-077 п.8)."
  import Ecto.Query
  alias AchievementsReal.Repo

  def run_once(codes) do
    watermark = Repo.one(from c in "cursors", where: c.achievement in ^codes, select: min(c.seq)) || 0

    Repo.transaction(fn ->
      Repo.query!("select pg_advisory_xact_lock(7702)")

      ready =
        from(o in "outbox",
          where: is_nil(o.published_at) and o.seq <= ^watermark,
          group_by: [o.occasion_event, o.seq],
          order_by: o.seq,
          select: {o.occasion_event, o.seq, fragment("array_agg(? || ':' || ? ORDER BY ?)", o.achievement, o.subject, o.achievement)}
        )
        |> Repo.all()

      ids = Enum.map(ready, &elem(&1, 0))
      Repo.update_all(from(o in "outbox", where: o.occasion_event in ^ids), set: [published_at: DateTime.utc_now()])
      ready
    end)
  end
end

defmodule AchievementsReal.Health.Server do
  use GRPC.Server, service: Grpc.Health.V1.Health.Service

  def check(_request, _stream) do
    status = if match?({:ok, _}, AchievementsReal.Repo.query("select 1")), do: :SERVING, else: :NOT_SERVING
    %Grpc.Health.V1.HealthCheckResponse{status: status}
  end
end

defmodule AchievementsReal.Endpoint do
  use GRPC.Endpoint
  run AchievementsReal.Health.Server
end

defmodule AchievementsReal.Shell do
  @moduledoc """
  Старт оболочки из Gleam main. В Gleam-корне нет config.exs и application
  callback: конфигурация Repo кладётся в env явно, дерево стартует вручную.
  """
  @ddl [
    "create table if not exists processed (achievement text, event_id text, primary key (achievement, event_id))",
    "create table if not exists rule_state (achievement text, subject text, count int not null, primary key (achievement, subject))",
    "create table if not exists grants (id bigserial primary key, achievement text not null, subject text not null, single boolean not null, occasion_event text not null, seq bigint not null, unique (achievement, subject))",
    "create unique index if not exists grants_single on grants (achievement) where single",
    "create table if not exists outbox (id bigserial primary key, occasion_event text not null, seq bigint not null, achievement text not null, subject text not null, published_at timestamptz)",
    "create table if not exists cursors (achievement text primary key, seq bigint not null)"
  ]

  def start do
    env = &System.get_env/2
    Application.put_env(:achievements_real, AchievementsReal.Repo,
      url: env.("DATABASE_URL", "ecto://postgres:spike@127.0.0.1:5432/achievements_real"), pool_size: 10)
    {:ok, _} = Application.ensure_all_started([:logger, :gnat, :ecto_sql, :postgrex, :grpc_server])
    # Без config.exs Logger стоит на :debug: Ecto пишет каждый запрос, и защита
    # логгера от перегрузки молча выбрасывает сообщения, вплоть до отчётов о падении.
    Logger.configure(level: :info)

    children = [
      AchievementsReal.Repo,
      {Gnat.ConnectionSupervisor,
       %{name: :gnat, connection_settings: [%{host: env.("NATS_HOST", "127.0.0.1"), port: String.to_integer(env.("NATS_PORT", "4222"))}]}},
      {DynamicSupervisor, name: AchievementsReal.Actors, strategy: :one_for_one, max_restarts: 20},
      {GRPC.Server.Supervisor, endpoint: AchievementsReal.Endpoint, port: String.to_integer(env.("GRPC_PORT", "50051")), start_server: true}
    ]

    {:ok, _} = Supervisor.start_link(children, strategy: :one_for_one, name: AchievementsReal.Supervisor)
    for sql <- @ddl, do: AchievementsReal.Repo.query!(sql)
    nil
  end

  def start_actor(code), do: DynamicSupervisor.start_child(AchievementsReal.Actors, {AchievementsReal.Actor, code})

  @doc "Режим сервиса: акторы всех ачивок из Gleam-реестра."
  def serve do
    for {:achievement, code, _, _, _} <- :achievements_real@rules.all(), do: start_actor(code)
    Process.sleep(:infinity)
  end
end

defmodule AchievementsReal.Scenario do
  @moduledoc "Сценарий спайка, тот же, что в Gleam-, Elixir- и Rust-спайках."
  alias AchievementsReal.{Actor, Relay, Repo, Shell}
  import Ecto.Query

  def run do
    {:ok, last} = last_seq()
    IO.puts("stream last_seq #{last}")
    Actor.arm_crash("collector", 30, :after_commit)
    Actor.arm_crash("bidder", 1, :before_commit)
    first = ["collector", "first_bidder", "bidder"]
    Enum.each(first, &Shell.start_actor/1)

    wait_all(["collector"], 20)
    IO.puts("killing collector mid-stream, cursor #{Actor.cursor("collector")}")
    Process.exit(Process.whereis(:ach_collector), :kill)
    wait_all(first, last)
    report("PHASE1", first)

    Shell.start_actor("first_payment")
    all = ["first_payment" | first]
    wait_all(all, last)
    report("PHASE2", all)

    IO.puts("PHASE2 DONE, waiting for phase 3 facts")
    last3 = wait_stream(last + 6)
    wait_all(all, last3)
    report("PHASE3", all)
    IO.puts("SCENARIO DONE")
    nil
  end

  defp last_seq do
    with {:ok, info} <- Gnat.Jetstream.API.Stream.info(:gnat, Actor.stream()), do: {:ok, info.state.last_seq}
  end

  defp wait_all(codes, seq) do
    unless Enum.all?(codes, &(Actor.cursor(&1) >= seq)), do: (Process.sleep(100); wait_all(codes, seq))
  end

  defp wait_stream(seq) do
    case last_seq() do
      {:ok, l} when l >= seq -> l
      _ -> Process.sleep(200); wait_stream(seq)
    end
  end

  defp report(phase, codes) do
    IO.puts("== #{phase}")
    for c <- codes, do: IO.puts("  cursor #{c} = #{Actor.cursor(c)}")
    counts = Repo.all(from s in "rule_state", where: s.achievement == "collector", order_by: s.subject, select: {s.subject, s.count})
    IO.puts("  collector counts #{inspect(counts)}")
    grants = Repo.all(from g in "grants", order_by: [g.achievement, g.subject], select: {g.achievement, g.subject, g.seq})
    IO.puts("  grants total #{length(grants)}")
    for g <- grants, do: IO.puts("  grant #{inspect(g)}")
    {:ok, ready} = Relay.run_once(codes)
    for {e, s, items} <- ready, do: IO.puts("  announce occasion seq #{s} #{e} -> #{inspect(items)}")
    IO.puts("  announcements #{length(ready)}")
  end
end
