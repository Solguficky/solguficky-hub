defmodule Achievements.AuctionFacts do
  @moduledoc """
  Разбор фактов стрима `AUCTION_EVENTS` в доменные факты правил. Сгенерированные
  модули `auction.v1` дальше этого модуля не выходят.

  Конверт выбирается по subject: последний сегмент `events.auction.<повод>` —
  имя ветки oneof `occasion` ровно одного конверта. Каждый повод каждого конверта
  стоит в `@occasions` — либо отображением в доменный факт, либо явным
  `:ignored`; полноту держит тест по сгенерированным модулям, поэтому новый повод
  в контракте валит CI, а не теряется молча (ADR-077, дополнение 2026-10-26).

  Каждый id, который правило может назвать получателем или ключом набора, здесь
  проверяется на каноническую форму UUID: неканоническое значение — битое тело, и
  позиция ачивки сдвигается. Пропусти его адаптер — правило назвало бы такого
  получателя, и ачивка встала бы дефектом правила до новой поставки.
  """

  alias Achievements.Fact

  alias Auction.V1.{
    AuctionEvent,
    AuctionState,
    InvoiceEvent,
    LotEvent,
    PredictionResultsEvent,
    RaffleEvent
  }

  @stream "AUCTION_EVENTS"
  @subject_prefix "events.auction."

  @envelopes [LotEvent, AuctionEvent, InvoiceEvent, RaffleEvent, PredictionResultsEvent]

  # Повод -> доменный вид факта или :ignored. Виды — те, что читают правила
  # первого набора (docs/product/future/achievements-auction.md); начало торгов
  # и конец аукциона у Auction приходят двумя поводами каждое, правило видит один
  # вид. Новый вид приходит вместе с первым правилом, которое его читает.
  @occasions %{
    LotEvent => %{
      lot_drafted: :ignored,
      lot_scheduled: :ignored,
      lot_opened: :lot_opened,
      bid_placed: :bid_placed,
      ask_advanced: :ignored,
      deadline_extended: :ignored,
      lot_sold: :lot_sold,
      lot_unsold: :lot_unsold,
      lot_withdrawn: :lot_withdrawn,
      lot_held_for_final: :lot_held_for_final,
      lot_resumed: :lot_resumed,
      step_window_added: :ignored,
      step_window_changed: :ignored,
      participant_removed: :participant_removed
    },
    AuctionEvent => %{
      auction_drafted: :ignored,
      auction_scheduled: :ignored,
      lot_added: :ignored,
      lot_removed: :ignored,
      prebidding_started: :trading_started,
      prebidding_deadline_reached: :ignored,
      # Конец аукциона без живого финала: тот же вид, что auction_finished, но
      # только со статусом finished в снимке (to_fact ниже).
      prebidding_ended: :auction_finished,
      final_lineup_frozen: :ignored,
      final_started: :trading_started,
      final_lot_activated: :ignored,
      final_lot_completed: :ignored,
      auction_finished: :auction_finished,
      auction_discarded: :ignored,
      # Отменённый аукцион конца не получает: правилам хода торгов хватает того,
      # что конца нет, а Коллекционер и Везунчик отмену не читают.
      auction_cancelled: :ignored,
      lot_set_collected: :ignored,
      auction_published: :ignored,
      auction_hidden: :ignored
    },
    InvoiceEvent => %{
      invoice_issued: :ignored,
      invoice_payment_due_changed: :ignored,
      invoice_paid: :invoice_paid,
      invoice_handed_over: :ignored
    },
    RaffleEvent => %{raffle_drawn: :raffle_drawn},
    PredictionResultsEvent => %{prediction_results_settled: :prediction_results_settled}
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
  читают, конец торгов, который аукцион не завершил, или subject вне фактов
  аукциона; `{:error, reason}` — тело, которое не разбирается схемой своего
  повода.
  """
  @spec decode(String.t(), binary()) :: {:ok, Fact.t()} | :ignored | {:error, String.t()}
  def decode(@subject_prefix <> occasion, payload) do
    case envelope(occasion) do
      {:ok, module, name, kind} -> decode(module, name, kind, payload)
      :error -> :ignored
    end
  end

  def decode(_subject, _payload), do: :ignored

  defp decode(_module, _name, :ignored, _payload), do: :ignored

  defp decode(module, name, kind, payload) do
    event = module.decode(payload)

    case event.occasion do
      {^name, _} -> to_fact(event, name, kind)
      _ -> {:error, "the body does not carry a #{name} fact"}
    end
  rescue
    Protobuf.DecodeError -> {:error, "the body is not #{inspect(module)}"}
  end

  defp envelope(occasion) do
    Enum.find_value(@occasions, :error, fn {module, kinds} ->
      Enum.find_value(kinds, fn {name, kind} ->
        if Atom.to_string(name) == occasion, do: {:ok, module, name, kind}
      end)
    end)
  end

  # Факты лота: событие — аукцион лота, порядок внутри лота — version.
  defp to_fact(%LotEvent{state: %{} = state} = event, name, kind) do
    with {:ok, data, subject} <- lot_data(name, event.occasion, state),
         :ok <- uuid(state.auction_id, "auction_id"),
         :ok <- uuid(event.lot_id, "lot_id"),
         :ok <- version(event.version) do
      fact(
        event,
        kind,
        state.auction_id,
        subject,
        Map.merge(data, %{lot_id: event.lot_id, version: event.version})
      )
    end
  end

  defp to_fact(%AuctionEvent{state: %AuctionState{} = state} = event, name, kind) do
    with :ok <- uuid(event.auction_id, "auction_id") do
      case {name, state.status} do
        {:prebidding_ended, {:finished, _}} -> with_lots(event, kind, state)
        {:prebidding_ended, _} -> :ignored
        _ -> with_lots(event, kind, state)
      end
    end
  end

  defp to_fact(%InvoiceEvent{state: %{} = state} = event, :invoice_paid, kind) do
    # auction_id — ключ набора: неканоническая форма завела бы набор, который
    # чтение по каноническому EventRef не найдёт никогда.
    with :ok <- uuid(state.auction_id, "auction_id"),
         :ok <- uuid(state.winner_id, "winner_id"),
         :ok <- uuid(state.lot_id, "lot_id"),
         :ok <- uuid(event.invoice_id, "invoice_id") do
      fact(event, kind, state.auction_id, state.winner_id, %{
        lot_id: state.lot_id,
        invoice_id: event.invoice_id
      })
    end
  end

  # Розыгрыш назван своим аукционом: raffle_id — auction_id (контракт).
  defp to_fact(%RaffleEvent{state: %{} = state} = event, :raffle_drawn, kind) do
    with :ok <- uuid(event.raffle_id, "raffle_id"),
         {:ok, winner} <- winning_holder(state) do
      fact(event, kind, event.raffle_id, winner, %{})
    end
  end

  defp to_fact(%PredictionResultsEvent{state: %{} = state} = event, _name, kind) do
    with :ok <- uuid(state.auction_id, "auction_id"),
         {:ok, participations} <- participations(state.participants) do
      fact(event, kind, state.auction_id, nil, %{
        manual: state.manual,
        participations: participations
      })
    end
  end

  defp to_fact(_event, name, _kind), do: {:error, "the body does not carry a #{name} fact"}

  # Начало торгов и конец аукциона несут реестр лотов снимка: правилу хода
  # торгов он нужен, чтобы решить лоты на любом из двух фактов.
  defp with_lots(event, kind, state) do
    with :ok <- all_uuid(state.lot_ids, "lot_ids") do
      fact(event, kind, event.auction_id, nil, %{lot_ids: state.lot_ids})
    end
  end

  # Ставящий — лидер снимка того же факта: ManualBid и ProxyBid его не несут.
  # При overtaken_by_proxy снимок ещё держит ставящего, а перебившая автоставка
  # приходит следующим фактом лота.
  defp lot_data(:bid_placed, {:bid_placed, bid}, state) do
    with {:ok, bidder} <- required(trading_leader(state), "state.trading.leader_id"),
         {:ok, origin} <- origin(bid.origin) do
      {:ok, %{bidder: bidder, origin: origin, overtaken: bid.overtaken_by_proxy}, bidder}
    end
  end

  defp lot_data(:lot_sold, _occasion, %{status: {:sold, sale}}) do
    with {:ok, winner} <- required(sale.winner_id, "state.sold.winner_id"),
         do: {:ok, %{winner: winner}, winner}
  end

  defp lot_data(:lot_sold, _occasion, _state), do: {:error, "lot_sold has no sale in its state"}

  defp lot_data(:participant_removed, {:participant_removed, removal}, state) do
    with {:ok, leader} <- optional(snapshot_leader(state), "leader_id"),
         {:ok, previous} <- optional(removal.previous_leader_id, "previous_leader_id") do
      {:ok, %{leader: leader, previous_leader: previous}, nil}
    end
  end

  defp lot_data(name, _occasion, state) when name in [:lot_held_for_final, :lot_resumed] do
    with {:ok, leader} <- optional(snapshot_leader(state), "leader_id"),
         do: {:ok, %{leader: leader}, nil}
  end

  defp lot_data(_name, _occasion, _state), do: {:ok, %{}, nil}

  defp trading_leader(%{status: {:trading, trading}}), do: trading.leader_id
  defp trading_leader(_state), do: nil

  # У лота на удержании trading пуст, лидер — в held: снятие с удержанного лота
  # законно (ADR-072).
  defp snapshot_leader(%{status: {:trading, trading}}), do: trading.leader_id
  defp snapshot_leader(%{status: {:held, held}}), do: held.leader_id
  defp snapshot_leader(_state), do: nil

  defp origin({:manual, _}), do: {:ok, :manual}
  defp origin({:proxy, _}), do: {:ok, :proxy}
  defp origin(_), do: {:error, "bid_placed has no origin"}

  defp winning_holder(%{tickets: tickets, winning_ticket: ticket})
       when ticket >= 1 and ticket <= length(tickets) do
    holder = Enum.at(tickets, ticket - 1)
    with :ok <- uuid(holder, "tickets"), do: {:ok, holder}
  end

  defp winning_holder(_state), do: {:error, "winning_ticket names no ticket"}

  # Участие — тройка «участник, номинация, угадал»: столько, сколько правилу
  # Пророка нужно, без отклонений и имён.
  defp participations(participants) do
    Enum.reduce_while(participants, {:ok, []}, fn participant, {:ok, acc} ->
      case uuid(participant.participant_id, "participant_id") do
        :ok ->
          rows =
            for p <- participant.participation do
              %{
                participant: participant.participant_id,
                nomination: p.nomination,
                guessed: match?({:guessed, _}, p.result)
              }
            end

          {:cont, {:ok, acc ++ rows}}

        error ->
          {:halt, error}
      end
    end)
  end

  defp fact(event, kind, auction, subject, data) do
    with {:ok, occurred_at} <- instant(event.occurred_at),
         :ok <- uuid(event.event_id, "event_id") do
      {:ok,
       %Fact{
         kind: kind,
         event_id: event.event_id,
         event: {:auction, auction},
         occurred_at: occurred_at,
         subject: subject,
         data: data
       }}
    end
  end

  defp instant(value) do
    case DateTime.from_iso8601(value) do
      {:ok, at, _offset} -> {:ok, at}
      {:error, _} -> {:error, "occurred_at is not an RFC 3339 instant"}
    end
  end

  defp version(value) when is_integer(value) and value > 0, do: :ok
  defp version(_value), do: {:error, "version is not a position of the lot journal"}

  defp required(nil, field), do: {:error, "#{field} is absent"}
  defp required(value, field), do: with(:ok <- uuid(value, field), do: {:ok, value})

  defp optional(nil, _field), do: {:ok, nil}
  defp optional(value, field), do: required(value, field)

  defp all_uuid(values, field) do
    if Enum.all?(values, &(uuid(&1, field) == :ok)),
      do: :ok,
      else: {:error, "#{field} holds a value that is not a canonical UUID"}
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
