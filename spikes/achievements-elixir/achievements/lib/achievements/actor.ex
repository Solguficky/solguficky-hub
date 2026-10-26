defmodule Achievements.Actor do
  @moduledoc """
  Актор ачивки: свой эфемерный consumer от курсора в PG, один факт в полёте,
  одна транзакция на факт, ack после commit.
  """
  use Gnat.Jetstream.PullConsumer
  import Ecto.Query
  alias Achievements.{Facts, Repo}
  alias Ecto.Multi
  alias Gnat.Jetstream.API.{Consumer, Message}
  require Logger

  @stream "ACH_FACTS"
  def stream, do: @stream

  def child_spec(mod),
    do: %{id: {__MODULE__, mod}, start: {__MODULE__, :start_link, [mod]}, restart: :permanent}

  def start_link(mod), do: Gnat.Jetstream.PullConsumer.start_link(__MODULE__, mod)

  def cursor(code),
    do: Repo.one(from c in "cursors", where: c.achievement == ^code, select: c.seq) || 0

  @impl true
  def init(mod) do
    Process.register(self(), :"ach_#{mod.code()}")
    from = cursor(mod.code()) + 1
    Logger.info("#{mod.code()}: start from seq #{from}")

    {:ok, mod,
     connection_name: :gnat,
     consumer: %Consumer{
       stream_name: @stream,
       deliver_policy: :by_start_sequence,
       opt_start_seq: from,
       ack_policy: :explicit,
       # inactive_threshold у эфемерного consumer PullConsumer отвергает (gnat 1.18.1,
       # вопреки moduledoc): сервер сам убирает его после отписки.
       max_ack_pending: 1
     }}
  end

  @impl true
  def handle_message(%{topic: subject, body: body} = message, mod) do
    {:ok, %{stream_seq: seq}} = Message.metadata(message)
    # Окно «посреди обработки»: факт получен, транзакция ещё не началась.
    Process.sleep(15)
    {:ok, %{grants: granted}} = transaction(mod, Facts.decode(subject, body), seq) |> Repo.transaction()

    if take_crash(mod.code(), seq, :after_commit),
      do: raise("#{mod.code()}: injected crash after commit, before ack")

    for s <- granted, do: Logger.info("#{mod.code()}: granted #{s} at seq #{seq}")
    {:ack, mod}
  end

  @doc "Тело транзакции: processed, правило, выдача с outbox, курсор."
  def transaction(mod, fact, seq) do
    code = mod.code()

    Multi.new()
    |> Multi.run(:grants, fn repo, _ ->
      with id when is_binary(id) <- Facts.event_id(fact),
           {1, _} <- repo.insert_all("processed", [%{achievement: code, event_id: id}], on_conflict: :nothing) do
        subjects =
          fact
          |> mod.rule(repo)
          |> Enum.uniq()
          |> Enum.reject(&repo.exists?(from g in "grants", where: g.achievement == ^code and g.subject == ^&1))

        rows = for s <- subjects, do: %{achievement: code, subject: s, occasion_event: id, seq: seq}
        repo.insert_all("grants", Enum.map(rows, &Map.put(&1, :single, mod.single?())))
        repo.insert_all("outbox", rows)
        {:ok, subjects}
      else
        _ -> {:ok, []}
      end
    end)
    |> Multi.insert_all(:cursor, "cursors", [%{achievement: code, seq: seq}],
      on_conflict: {:replace, [:seq]}, conflict_target: :achievement)
    |> Multi.run(:crash, fn _, _ ->
      if take_crash(code, seq, :before_commit),
        do: raise("#{code}: injected crash inside transaction"),
        else: {:ok, nil}
    end)
  end

  def arm_crash(code, seq, where), do: :persistent_term.put({:crash, code, seq, where}, true)

  defp take_crash(code, seq, where) do
    :persistent_term.get({:crash, code, seq, where}, false) and
      :persistent_term.erase({:crash, code, seq, where})
  end
end
