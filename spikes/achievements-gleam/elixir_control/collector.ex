# Контроль на Elixir: то же правило «Коллекционер» на GenServer + Ecto.Multi.
# НЕ СОБИРАЛОСЬ: gnat, ecto_sql, postgrex и protobuf — пакеты hex, а repo.hex.pm
# закрыт политикой сети среды. Файл служит только для сравнения объёма кода;
# API сверен по документации gnat 1.18 и ecto 3.x, не компилятором.
defmodule Achievements.Achievement do
  @callback code() :: String.t()
  @callback single?() :: boolean()
  @callback rule(fact :: term()) :: [String.t()]
end

defmodule Achievements.Collector do
  @behaviour Achievements.Achievement
  import Ecto.Query
  alias Achievements.{Repo, RuleState}

  def code, do: "collector"
  def single?, do: false

  def rule({:invoice, %{occasion: {:invoice_paid, _}, state: %{winner_id: w}}}) do
    n = (Repo.one(from s in RuleState, where: s.code == ^code() and s.subject == ^w, select: s.count) || 0) + 1
    Repo.insert!(%RuleState{code: code(), subject: w, count: n},
      on_conflict: [set: [count: n]], conflict_target: [:code, :subject])
    if n == 3, do: [w], else: []
  end

  def rule(_), do: []
end

defmodule Achievements.Actor do
  use GenServer
  alias Achievements.{Repo, Processed, Grant, Outbox, Cursor}
  alias Ecto.Multi

  @stream "ACH_FACTS"

  def start_link(mod), do: GenServer.start_link(__MODULE__, mod, name: {:global, {:ach, mod.code()}})

  @impl true
  def init(mod) do
    from = cursor(mod.code()) + 1
    {:ok, consumer} =
      Gnat.Jetstream.API.Consumer.create(:gnat, %Gnat.Jetstream.API.Consumer{
        stream_name: @stream, deliver_policy: :by_start_sequence, opt_start_seq: from,
        ack_policy: :explicit, max_ack_pending: 1, inactive_threshold: 60_000_000_000})
    send(self(), :poll)
    {:ok, %{mod: mod, consumer: consumer.name}}
  end

  @impl true
  def handle_info(:poll, %{mod: mod} = st) do
    case Gnat.Jetstream.API.Consumer.request_next_message(:gnat, @stream, st.consumer, "_INBOX.#{mod.code()}") do
      {:ok, %{topic: subject, body: body, reply_to: ack} = msg} ->
        seq = Gnat.Jetstream.Message.metadata(msg).stream_seq
        fact = decode(subject, body)
        {:ok, _} = Repo.transaction(apply(mod, fact, seq))
        Gnat.Jetstream.ack(msg)
        _ = ack
        send(self(), :poll)
      _empty ->
        Process.send_after(self(), :poll, 200)
    end
    {:noreply, st}
  end

  defp apply(mod, fact, seq) do
    code = mod.code()
    Multi.new()
    |> Multi.run(:grants, fn repo, _ ->
      case event_id(fact) do
        nil -> {:ok, []}
        id ->
          case repo.insert(%Processed{code: code, event_id: id}, on_conflict: :nothing) do
            {:ok, %{id: nil}} -> {:ok, []}
            {:ok, _} ->
              subjects =
                mod.rule(fact) |> Enum.uniq()
                |> Enum.reject(&repo.exists?(Grant.by(code, &1)))
              Enum.each(subjects, fn s ->
                repo.insert!(%Grant{code: code, subject: s, single: mod.single?(), source_event: id, seq: seq})
                repo.insert!(%Outbox{occasion_event: id, seq: seq, code: code, subject: s})
              end)
              {:ok, subjects}
          end
      end
    end)
    |> Multi.insert(:cursor, %Cursor{code: code, seq: seq},
      on_conflict: [set: [seq: seq]], conflict_target: :code)
  end

  defp cursor(code), do: (Repo.get(Cursor, code) || %{seq: 0}).seq

  defp decode("events.auction.invoice_paid", b), do: {:invoice, Auction.V1.InvoiceEvent.decode(b)}
  defp decode("events.auction.bid_placed", b), do: {:lot, Auction.V1.LotEvent.decode(b)}
  defp decode(_, _), do: :ignored

  defp event_id({_, %{event_id: id}}), do: id
  defp event_id(_), do: nil
end
