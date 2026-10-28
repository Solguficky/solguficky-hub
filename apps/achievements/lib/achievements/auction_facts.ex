defmodule Achievements.AuctionFacts do
  @moduledoc """
  Разбор фактов стрима `AUCTION_EVENTS` в доменные факты правил. Сгенерированные
  модули `auction.v1` дальше этого модуля не выходят.

  Конверт выбирается по subject: последний сегмент `events.auction.<повод>` —
  имя ветки oneof `occasion` ровно одного конверта. Каждый повод каждого конверта
  стоит в `@occasions` — либо отображением в доменный факт, либо явным
  `:ignored`; полноту держит тест по сгенерированным модулям, поэтому новый повод
  в контракте валит CI, а не теряется молча (ADR-077, дополнение 2026-10-26).
  """

  alias Achievements.Fact
  alias Auction.V1.{AuctionEvent, InvoiceEvent, LotEvent, PredictionResultsEvent, RaffleEvent}

  @stream "AUCTION_EVENTS"
  @subject_prefix "events.auction."

  @envelopes [LotEvent, AuctionEvent, InvoiceEvent, RaffleEvent, PredictionResultsEvent]

  # Повод -> доменный вид факта или :ignored. Правилам пока нужен один вид:
  # оплаченный счёт — устоявшаяся покупка (ADR-075). Новый вид приходит вместе
  # с первым правилом, которое его читает.
  @occasions %{
    LotEvent => %{
      lot_drafted: :ignored,
      lot_scheduled: :ignored,
      lot_opened: :ignored,
      bid_placed: :ignored,
      ask_advanced: :ignored,
      deadline_extended: :ignored,
      lot_sold: :ignored,
      lot_unsold: :ignored,
      lot_withdrawn: :ignored,
      lot_held_for_final: :ignored,
      lot_resumed: :ignored,
      step_window_added: :ignored,
      step_window_changed: :ignored,
      participant_removed: :ignored
    },
    AuctionEvent => %{
      auction_drafted: :ignored,
      auction_scheduled: :ignored,
      lot_added: :ignored,
      lot_removed: :ignored,
      prebidding_started: :ignored,
      prebidding_deadline_reached: :ignored,
      prebidding_ended: :ignored,
      final_lineup_frozen: :ignored,
      final_started: :ignored,
      final_lot_activated: :ignored,
      final_lot_completed: :ignored,
      auction_finished: :ignored,
      auction_discarded: :ignored,
      auction_cancelled: :ignored,
      lot_set_collected: :ignored,
      auction_published: :ignored,
      auction_hidden: :ignored
    },
    InvoiceEvent => %{
      invoice_issued: :ignored,
      invoice_paid: :invoice_paid,
      invoice_handed_over: :ignored
    },
    RaffleEvent => %{raffle_drawn: :ignored},
    PredictionResultsEvent => %{prediction_results_settled: :ignored}
  }

  @doc "Стрим, который читают акторы ачивок аукциона."
  def stream, do: @stream

  @doc "Фильтр subject потребителя стрима."
  def filter_subject, do: @subject_prefix <> ">"

  @doc false
  def envelopes, do: @envelopes

  @doc false
  def occasions, do: @occasions

  @doc """
  Доменный факт из сообщения стрима. `:ignored` — повод, который правила не
  читают, или subject вне фактов аукциона; `{:error, reason}` — тело, которое не
  разбирается схемой своего повода.
  """
  @spec decode(String.t(), binary()) :: {:ok, Fact.t()} | :ignored | {:error, String.t()}
  def decode(@subject_prefix <> occasion, payload) do
    case envelope(occasion) do
      {:ok, module, kind} -> decode(module, kind, payload)
      :error -> :ignored
    end
  end

  def decode(_subject, _payload), do: :ignored

  defp decode(_module, :ignored, _payload), do: :ignored

  defp decode(module, kind, payload) do
    module.decode(payload)
    |> to_fact(kind)
  rescue
    Protobuf.DecodeError -> {:error, "the body is not #{inspect(module)}"}
  end

  defp envelope(occasion) do
    Enum.find_value(@occasions, :error, fn {module, kinds} ->
      Enum.find_value(kinds, fn {name, kind} ->
        if Atom.to_string(name) == occasion, do: {:ok, module, kind}
      end)
    end)
  end

  defp to_fact(
         %InvoiceEvent{
           occasion: {:invoice_paid, _},
           state: %{auction_id: auction, winner_id: winner}
         } =
           event,
         :invoice_paid
       )
       when auction != "" do
    with {:ok, occurred_at} <- instant(event.occurred_at),
         :ok <- uuid(event.event_id, "event_id"),
         :ok <- uuid(winner, "winner_id") do
      {:ok,
       %Fact{
         kind: :invoice_paid,
         event_id: event.event_id,
         event: {:auction, auction},
         occurred_at: occurred_at,
         subject: winner,
         data: %{lot_id: event.state.lot_id, invoice_id: event.invoice_id}
       }}
    end
  end

  defp to_fact(_event, kind), do: {:error, "the body does not carry a #{kind} fact"}

  defp instant(value) do
    case DateTime.from_iso8601(value) do
      {:ok, at, _offset} -> {:ok, at}
      {:error, _} -> {:error, "occurred_at is not an RFC 3339 instant"}
    end
  end

  # Реестр хранит id колонками uuid: неканоническое значение — битое тело, а
  # не исключение посреди транзакции.
  defp uuid(value, field) do
    case Achievements.Proto.uuid(value) do
      {:ok, _} -> :ok
      :error -> {:error, "#{field} is not a canonical UUID"}
    end
  end
end
