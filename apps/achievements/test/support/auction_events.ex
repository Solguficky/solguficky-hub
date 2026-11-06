defmodule Achievements.Test.AuctionEvents do
  @moduledoc false
  # Сообщения стрима AUCTION_EVENTS в настоящем протобуфе контракта: тесты
  # правил гонят их через тот же разбор, что и актор, поэтому проверяют и
  # отображение фактов, а не только правило. Каждое сообщение — {subject, тело};
  # повтор того же факта — то же сообщение ещё раз.

  alias Auction.V1.{
    AuctionConfig,
    AuctionEvent,
    AuctionFinished,
    AuctionState,
    BidPlaced,
    FinalStarted,
    Guessed,
    InvoiceEvent,
    InvoicePaid,
    InvoiceState,
    LotEvent,
    LotHeld,
    LotHeldForFinal,
    LotOpened,
    LotResumed,
    LotSale,
    LotSold,
    LotState,
    LotTrading,
    LotUnsold,
    LotWithdrawn,
    ManualBid,
    Missed,
    OnlinePhase,
    ParticipantRemoved,
    ParticipantResult,
    Participation,
    PredictionResultsEvent,
    PredictionResultsSettled,
    PredictionResultsState,
    PrebiddingEnded,
    PrebiddingStarted,
    ProxyBid,
    RaffleDrawn,
    RaffleEvent,
    RaffleState
  }

  @at "2026-11-10T12:00:00Z"

  def uuid, do: Achievements.UUID7.generate()

  # --- Аукцион ---

  def prebidding_started(auction, lots, opts \\ []),
    do: auction(auction, :prebidding_started, %PrebiddingStarted{}, prebidding(), lots, opts)

  @doc "Начало финала; `online: true` — у аукциона есть онлайн-этап."
  def final_started(auction, lots, opts \\ []),
    do: auction(auction, :final_started, %FinalStarted{}, final(lots), lots, opts)

  def auction_finished(auction, lots, opts \\ []),
    do: auction(auction, :auction_finished, %AuctionFinished{}, finished(), lots, opts)

  def prebidding_ended(auction, lots, status, opts \\ []) do
    state = if status == :finished, do: finished(), else: {:on_break, %AuctionState.Break{}}
    auction(auction, :prebidding_ended, %PrebiddingEnded{}, state, lots, opts)
  end

  def auction_cancelled(auction, lots, opts \\ []),
    do:
      auction(
        auction,
        :auction_cancelled,
        %Auction.V1.AuctionCancelled{},
        {:cancelled, %AuctionState.Cancelled{}},
        lots,
        opts
      )

  defp config(true),
    do: %AuctionConfig{
      online_phase: %OnlinePhase{opens_at: "2026-11-09T09:00:00Z"}
    }

  defp config(false), do: %AuctionConfig{}

  defp prebidding, do: {:prebidding, %AuctionState.Prebidding{}}
  defp final(lots), do: {:in_final, %AuctionState.Final{order: lots}}
  defp finished, do: {:finished, %AuctionState.Finished{}}

  defp auction(auction, name, occasion, status, lots, opts) do
    event = %AuctionEvent{
      event_id: Keyword.get(opts, :event_id, uuid()),
      auction_id: auction,
      version: Keyword.get(opts, :version, 1),
      occurred_at: Keyword.get(opts, :at, @at),
      state: %AuctionState{
        id: auction,
        lot_ids: lots,
        status: status,
        config: config(Keyword.get(opts, :online, false))
      },
      occasion: {name, occasion}
    }

    {"events.auction.#{name}", AuctionEvent.encode(event)}
  end

  # --- Лот ---

  def lot_opened(auction, lot, version, opts \\ []),
    do: lot(auction, lot, version, :lot_opened, %LotOpened{}, trading(nil), opts)

  @doc "Ставка; `bidder` — лидер снимка, как пишет Auction."
  def bid(auction, lot, version, bidder, opts \\ []) do
    origin =
      case Keyword.get(opts, :origin, :manual) do
        :manual -> {:manual, %ManualBid{source: Keyword.get(opts, :source, :BID_SOURCE_BOT)}}
        :proxy -> {:proxy, %ProxyBid{}}
      end

    occasion = %BidPlaced{
      previous_leader_id: Keyword.get(opts, :previous),
      origin: origin,
      overtaken_by_proxy: Keyword.get(opts, :overtaken, false)
    }

    lot(auction, lot, version, :bid_placed, occasion, trading(bidder), opts)
  end

  def lot_sold(auction, lot, version, winner, opts \\ []),
    do:
      lot(
        auction,
        lot,
        version,
        :lot_sold,
        %LotSold{},
        {:sold, %LotSale{winner_id: winner, bid_id: uuid()}},
        opts
      )

  def lot_unsold(auction, lot, version, opts \\ []),
    do:
      lot(
        auction,
        lot,
        version,
        :lot_unsold,
        %LotUnsold{},
        {:unsold, :UNSOLD_REASON_UNSPECIFIED},
        opts
      )

  def lot_withdrawn(auction, lot, version, opts \\ []),
    do:
      lot(
        auction,
        lot,
        version,
        :lot_withdrawn,
        %LotWithdrawn{},
        {:withdrawn, :WITHDRAWN_REASON_UNSPECIFIED},
        opts
      )

  def lot_held(auction, lot, version, leader, opts \\ []),
    do: lot(auction, lot, version, :lot_held_for_final, %LotHeldForFinal{}, held(leader), opts)

  def lot_resumed(auction, lot, version, leader, opts \\ []),
    do: lot(auction, lot, version, :lot_resumed, %LotResumed{}, trading(leader), opts)

  @doc "Снятие участника; `held: true` — снятие с удержанного лота."
  def participant_removed(auction, lot, version, leader, previous, opts \\ []) do
    state = if Keyword.get(opts, :held, false), do: held(leader), else: trading(leader)

    lot(
      auction,
      lot,
      version,
      :participant_removed,
      %ParticipantRemoved{previous_leader_id: previous},
      state,
      opts
    )
  end

  defp trading(leader), do: {:trading, %LotTrading{leader_id: leader}}
  defp held(leader), do: {:held, %LotHeld{leader_id: leader}}

  defp lot(auction, lot, version, name, occasion, status, opts) do
    event = %LotEvent{
      event_id: Keyword.get(opts, :event_id, uuid()),
      lot_id: lot,
      version: version,
      occurred_at: Keyword.get(opts, :at, @at),
      state: %LotState{id: lot, auction_id: auction, status: status},
      occasion: {name, occasion}
    }

    {"events.auction.#{name}", LotEvent.encode(event)}
  end

  # --- Счёт, розыгрыш, прогнозы ---

  def invoice_paid(auction, lot, buyer, opts \\ []) do
    event = %InvoiceEvent{
      event_id: Keyword.get(opts, :event_id, uuid()),
      invoice_id: Keyword.get(opts, :invoice, uuid()),
      version: 2,
      occurred_at: Keyword.get(opts, :at, @at),
      state: %InvoiceState{auction_id: auction, lot_id: lot, winner_id: buyer},
      occasion: {:invoice_paid, %InvoicePaid{}}
    }

    {"events.auction.invoice_paid", InvoiceEvent.encode(event)}
  end

  def raffle_drawn(auction, tickets, winning, opts \\ []) do
    event = %RaffleEvent{
      event_id: Keyword.get(opts, :event_id, uuid()),
      raffle_id: auction,
      version: 1,
      occurred_at: Keyword.get(opts, :at, @at),
      state: %RaffleState{tickets: tickets, winning_ticket: winning},
      occasion: {:raffle_drawn, %RaffleDrawn{}}
    }

    {"events.auction.raffle_drawn", RaffleEvent.encode(event)}
  end

  @doc """
  Итоги прогнозов; `answers` — `{участник, [{номинация, :guessed | :missed}]}`.
  """
  def prediction_results(auction, answers, opts \\ []) do
    participants =
      for {participant, results} <- answers do
        %ParticipantResult{
          participant_id: participant,
          participation:
            for {nomination, result} <- results do
              %Participation{
                nomination: nomination,
                result:
                  case result do
                    :guessed -> {:guessed, %Guessed{}}
                    :missed -> {:missed, %Missed{}}
                  end
              }
            end
        }
      end

    event = %PredictionResultsEvent{
      event_id: Keyword.get(opts, :event_id, uuid()),
      prediction_results_id: auction,
      version: 1,
      occurred_at: Keyword.get(opts, :at, @at),
      state: %PredictionResultsState{
        auction_id: auction,
        participants: participants,
        manual: Keyword.get(opts, :manual, false)
      },
      occasion: {:prediction_results_settled, %PredictionResultsSettled{}}
    }

    {"events.auction.prediction_results_settled", PredictionResultsEvent.encode(event)}
  end
end
