defmodule Auction.V1.LotEvent do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotEvent",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :occasion, 0

  field :event_id, 1, type: :string, json_name: "eventId"
  field :lot_id, 2, type: :string, json_name: "lotId"
  field :version, 3, type: :int64
  field :occurred_at, 4, type: :string, json_name: "occurredAt"
  field :state, 5, type: Auction.V1.LotState
  field :lot_drafted, 15, type: Auction.V1.LotDrafted, json_name: "lotDrafted", oneof: 0
  field :lot_scheduled, 16, type: Auction.V1.LotScheduled, json_name: "lotScheduled", oneof: 0
  field :lot_opened, 6, type: Auction.V1.LotOpened, json_name: "lotOpened", oneof: 0
  field :bid_placed, 7, type: Auction.V1.BidPlaced, json_name: "bidPlaced", oneof: 0
  field :ask_advanced, 8, type: Auction.V1.AskAdvanced, json_name: "askAdvanced", oneof: 0

  field :deadline_extended, 9,
    type: Auction.V1.DeadlineExtended,
    json_name: "deadlineExtended",
    oneof: 0

  field :lot_sold, 10, type: Auction.V1.LotSold, json_name: "lotSold", oneof: 0
  field :lot_unsold, 11, type: Auction.V1.LotUnsold, json_name: "lotUnsold", oneof: 0
  field :lot_withdrawn, 12, type: Auction.V1.LotWithdrawn, json_name: "lotWithdrawn", oneof: 0

  field :lot_held_for_final, 13,
    type: Auction.V1.LotHeldForFinal,
    json_name: "lotHeldForFinal",
    oneof: 0

  field :lot_resumed, 14, type: Auction.V1.LotResumed, json_name: "lotResumed", oneof: 0

  field :step_window_added, 17,
    type: Auction.V1.StepWindowAdded,
    json_name: "stepWindowAdded",
    oneof: 0

  field :participant_removed, 18,
    type: Auction.V1.ParticipantRemoved,
    json_name: "participantRemoved",
    oneof: 0
end

defmodule Auction.V1.LotState do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotState",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :status, 0

  field :id, 1, type: :string
  field :auction_id, 2, type: :string, json_name: "auctionId"
  field :config, 3, type: Auction.V1.LotConfig
  field :draft, 8, type: Auction.V1.LotDraft, oneof: 0
  field :scheduled, 9, type: Auction.V1.LotSchedule, oneof: 0
  field :trading, 10, type: Auction.V1.LotTrading, oneof: 0
  field :held, 11, type: Auction.V1.LotHeld, oneof: 0
  field :sold, 12, type: Auction.V1.LotSale, oneof: 0
  field :unsold, 13, type: Auction.V1.UnsoldReason, enum: true, oneof: 0
  field :withdrawn, 14, type: Auction.V1.WithdrawnReason, enum: true, oneof: 0
  field :step_windows, 19, repeated: true, type: Auction.V1.StepWindow, json_name: "stepWindows"
end

defmodule Auction.V1.StepWindow do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.StepWindow",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :from, 1, type: :string
  field :until, 2, type: :string
  field :step, 3, type: Auction.V1.Money
end

defmodule Auction.V1.LotDrafted do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotDrafted",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.LotScheduled do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotScheduled",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.LotOpened do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotOpened",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.BidPlaced do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.BidPlaced",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :origin, 0

  field :previous_leader_id, 1,
    proto3_optional: true,
    type: :string,
    json_name: "previousLeaderId"

  field :manual, 2, type: Auction.V1.ManualBid, oneof: 0
  field :proxy, 3, type: Auction.V1.ProxyBid, oneof: 0
  field :overtaken_by_proxy, 4, type: :bool, json_name: "overtakenByProxy"
  field :answers_other_bidder, 5, type: :bool, json_name: "answersOtherBidder"
end

defmodule Auction.V1.ManualBid do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.ManualBid",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :source, 1, type: Auction.V1.BidSource, enum: true
end

defmodule Auction.V1.ProxyBid do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.ProxyBid",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AskAdvanced do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AskAdvanced",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.DeadlineExtended do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.DeadlineExtended",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.LotSold do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotSold",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.LotUnsold do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotUnsold",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.LotWithdrawn do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotWithdrawn",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.LotHeldForFinal do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotHeldForFinal",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.LotResumed do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotResumed",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.StepWindowAdded do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.StepWindowAdded",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.ParticipantRemoved do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.ParticipantRemoved",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :previous_leader_id, 1,
    proto3_optional: true,
    type: :string,
    json_name: "previousLeaderId"
end

defmodule Auction.V1.AuctionEvent do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionEvent",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :occasion, 0

  field :event_id, 1, type: :string, json_name: "eventId"
  field :auction_id, 2, type: :string, json_name: "auctionId"
  field :version, 3, type: :int64
  field :occurred_at, 4, type: :string, json_name: "occurredAt"
  field :state, 5, type: Auction.V1.AuctionState

  field :auction_drafted, 17,
    type: Auction.V1.AuctionDrafted,
    json_name: "auctionDrafted",
    oneof: 0

  field :auction_scheduled, 6,
    type: Auction.V1.AuctionScheduled,
    json_name: "auctionScheduled",
    oneof: 0

  field :lot_added, 7, type: Auction.V1.LotAdded, json_name: "lotAdded", oneof: 0
  field :lot_removed, 8, type: Auction.V1.LotRemoved, json_name: "lotRemoved", oneof: 0

  field :prebidding_started, 9,
    type: Auction.V1.PrebiddingStarted,
    json_name: "prebiddingStarted",
    oneof: 0

  field :prebidding_deadline_reached, 10,
    type: Auction.V1.PrebiddingDeadlineReached,
    json_name: "prebiddingDeadlineReached",
    oneof: 0

  field :prebidding_ended, 11,
    type: Auction.V1.PrebiddingEnded,
    json_name: "prebiddingEnded",
    oneof: 0

  field :final_lineup_frozen, 12,
    type: Auction.V1.FinalLineupFrozen,
    json_name: "finalLineupFrozen",
    oneof: 0

  field :final_started, 13, type: Auction.V1.FinalStarted, json_name: "finalStarted", oneof: 0

  field :final_lot_activated, 14,
    type: Auction.V1.FinalLotActivated,
    json_name: "finalLotActivated",
    oneof: 0

  field :final_lot_completed, 15,
    type: Auction.V1.FinalLotCompleted,
    json_name: "finalLotCompleted",
    oneof: 0

  field :auction_finished, 16,
    type: Auction.V1.AuctionFinished,
    json_name: "auctionFinished",
    oneof: 0

  field :auction_discarded, 18,
    type: Auction.V1.AuctionDiscarded,
    json_name: "auctionDiscarded",
    oneof: 0

  field :auction_cancelled, 19,
    type: Auction.V1.AuctionCancelled,
    json_name: "auctionCancelled",
    oneof: 0

  field :lot_set_collected, 20,
    type: Auction.V1.LotSetCollected,
    json_name: "lotSetCollected",
    oneof: 0

  field :auction_published, 21,
    type: Auction.V1.AuctionPublished,
    json_name: "auctionPublished",
    oneof: 0

  field :auction_hidden, 22, type: Auction.V1.AuctionHidden, json_name: "auctionHidden", oneof: 0
end

defmodule Auction.V1.AuctionState.Draft do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.Draft",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionState.Scheduled do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.Scheduled",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionState.Prebidding do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.Prebidding",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionState.Settling do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.Settling",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionState.Break do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.Break",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionState.LineupFrozen do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.LineupFrozen",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :order, 1, repeated: true, type: :string
end

defmodule Auction.V1.AuctionState.Final do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.Final",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :order, 1, repeated: true, type: :string
  field :active_lot_id, 2, proto3_optional: true, type: :string, json_name: "activeLotId"
end

defmodule Auction.V1.AuctionState.Finished do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.Finished",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionState.Cancelled do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.Cancelled",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionState.Discarded do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState.Discarded",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionState do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionState",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :status, 0

  field :id, 1, type: :string
  field :config, 2, type: Auction.V1.AuctionConfig
  field :lot_ids, 3, repeated: true, type: :string, json_name: "lotIds"
  field :meetup_id, 4, type: :string, json_name: "meetupId"
  field :hidden, 5, type: :bool
  field :draft, 10, type: Auction.V1.AuctionState.Draft, oneof: 0
  field :scheduled, 11, type: Auction.V1.AuctionState.Scheduled, oneof: 0
  field :prebidding, 12, type: Auction.V1.AuctionState.Prebidding, oneof: 0
  field :settling, 13, type: Auction.V1.AuctionState.Settling, oneof: 0
  field :on_break, 14, type: Auction.V1.AuctionState.Break, json_name: "onBreak", oneof: 0

  field :lineup_frozen, 15,
    type: Auction.V1.AuctionState.LineupFrozen,
    json_name: "lineupFrozen",
    oneof: 0

  field :in_final, 16, type: Auction.V1.AuctionState.Final, json_name: "inFinal", oneof: 0
  field :finished, 17, type: Auction.V1.AuctionState.Finished, oneof: 0
  field :cancelled, 18, type: Auction.V1.AuctionState.Cancelled, oneof: 0
  field :discarded, 19, type: Auction.V1.AuctionState.Discarded, oneof: 0
end

defmodule Auction.V1.AuctionDrafted do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionDrafted",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionScheduled do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionScheduled",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.LotAdded do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotAdded",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :lot_id, 1, type: :string, json_name: "lotId"
end

defmodule Auction.V1.LotRemoved do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotRemoved",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :lot_id, 1, type: :string, json_name: "lotId"
end

defmodule Auction.V1.LotSetCollected do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotSetCollected",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :lot_set_id, 1, type: :string, json_name: "lotSetId"
  field :name, 2, type: :string
  field :lot_ids, 3, repeated: true, type: :string, json_name: "lotIds"
  field :collector_id, 4, type: :string, json_name: "collectorId"
end

defmodule Auction.V1.PrebiddingStarted do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.PrebiddingStarted",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.PrebiddingDeadlineReached do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.PrebiddingDeadlineReached",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.PrebiddingEnded do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.PrebiddingEnded",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.FinalLineupFrozen do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.FinalLineupFrozen",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.FinalStarted do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.FinalStarted",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.FinalLotActivated do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.FinalLotActivated",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.FinalLotCompleted do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.FinalLotCompleted",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :lot_id, 1, type: :string, json_name: "lotId"
end

defmodule Auction.V1.AuctionFinished do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionFinished",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionDiscarded do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionDiscarded",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionCancelled do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionCancelled",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionPublished do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionPublished",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.AuctionHidden do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionHidden",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.InvoiceEvent do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.InvoiceEvent",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :occasion, 0

  field :event_id, 1, type: :string, json_name: "eventId"
  field :invoice_id, 2, type: :string, json_name: "invoiceId"
  field :version, 3, type: :int64
  field :occurred_at, 4, type: :string, json_name: "occurredAt"
  field :state, 5, type: Auction.V1.InvoiceState
  field :invoice_issued, 6, type: Auction.V1.InvoiceIssued, json_name: "invoiceIssued", oneof: 0
  field :invoice_paid, 7, type: Auction.V1.InvoicePaid, json_name: "invoicePaid", oneof: 0

  field :invoice_handed_over, 8,
    type: Auction.V1.InvoiceHandedOver,
    json_name: "invoiceHandedOver",
    oneof: 0
end

defmodule Auction.V1.InvoiceState.AwaitingPayment do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.InvoiceState.AwaitingPayment",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.InvoiceState.Paid do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.InvoiceState.Paid",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.InvoiceState.HandedOver do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.InvoiceState.HandedOver",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.InvoiceState do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.InvoiceState",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :status, 0

  field :id, 1, type: :string
  field :auction_id, 2, type: :string, json_name: "auctionId"
  field :lot_id, 3, type: :string, json_name: "lotId"
  field :winner_id, 4, type: :string, json_name: "winnerId"
  field :amount, 5, type: Auction.V1.Money
  field :payment_due_at, 6, type: :string, json_name: "paymentDueAt"

  field :awaiting_payment, 10,
    type: Auction.V1.InvoiceState.AwaitingPayment,
    json_name: "awaitingPayment",
    oneof: 0

  field :paid, 11, type: Auction.V1.InvoiceState.Paid, oneof: 0

  field :handed_over, 12,
    type: Auction.V1.InvoiceState.HandedOver,
    json_name: "handedOver",
    oneof: 0
end

defmodule Auction.V1.InvoiceIssued do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.InvoiceIssued",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.InvoicePaid do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.InvoicePaid",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.InvoiceHandedOver do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.InvoiceHandedOver",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.RaffleEvent do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.RaffleEvent",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :occasion, 0

  field :event_id, 1, type: :string, json_name: "eventId"
  field :raffle_id, 2, type: :string, json_name: "raffleId"
  field :version, 3, type: :int64
  field :occurred_at, 4, type: :string, json_name: "occurredAt"
  field :state, 5, type: Auction.V1.RaffleState
  field :raffle_drawn, 6, type: Auction.V1.RaffleDrawn, json_name: "raffleDrawn", oneof: 0
end

defmodule Auction.V1.RaffleState do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.RaffleState",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :tickets, 1, repeated: true, type: :string
  field :winning_ticket, 2, type: :uint32, json_name: "winningTicket"
  field :raffle_prize, 3, proto3_optional: true, type: :string, json_name: "rafflePrize"
end

defmodule Auction.V1.RaffleDrawn do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.RaffleDrawn",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.PredictionResultsEvent do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.PredictionResultsEvent",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :occasion, 0

  field :event_id, 1, type: :string, json_name: "eventId"
  field :prediction_results_id, 2, type: :string, json_name: "predictionResultsId"
  field :version, 3, type: :int64
  field :occurred_at, 4, type: :string, json_name: "occurredAt"
  field :state, 5, type: Auction.V1.PredictionResultsState

  field :prediction_results_settled, 6,
    type: Auction.V1.PredictionResultsSettled,
    json_name: "predictionResultsSettled",
    oneof: 0
end

defmodule Auction.V1.PredictionResultsState do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.PredictionResultsState",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :auction_id, 1, type: :string, json_name: "auctionId"
  field :nominations, 2, repeated: true, type: Auction.V1.NominationOutcome
  field :participants, 3, repeated: true, type: Auction.V1.ParticipantResult
  field :manual, 4, type: :bool
end

defmodule Auction.V1.NominationOutcome do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.NominationOutcome",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :value, 0

  field :nomination, 1, type: Auction.V1.PredictionNomination, enum: true
  field :lots, 2, type: Auction.V1.NominationLots, oneof: 0
  field :number, 3, type: :int64, oneof: 0
  field :winners, 4, type: :uint32
  field :winner_names, 5, repeated: true, type: Auction.V1.WinnerName, json_name: "winnerNames"
end

defmodule Auction.V1.NominationLots do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.NominationLots",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :lot_ids, 1, repeated: true, type: :string, json_name: "lotIds"
end

defmodule Auction.V1.WinnerName do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.WinnerName",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :participant_id, 1, type: :string, json_name: "participantId"
  field :name, 2, type: :string
end

defmodule Auction.V1.ParticipantResult do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.ParticipantResult",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :participant_id, 1, type: :string, json_name: "participantId"
  field :participation, 2, repeated: true, type: Auction.V1.Participation
end

defmodule Auction.V1.Participation do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.Participation",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :result, 0

  field :nomination, 1, type: Auction.V1.PredictionNomination, enum: true
  field :guessed, 2, type: Auction.V1.Guessed, oneof: 0
  field :missed, 3, type: Auction.V1.Missed, oneof: 0
end

defmodule Auction.V1.Guessed do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.Guessed",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.Missed do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.Missed",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :deviation, 1, proto3_optional: true, type: :int64
end

defmodule Auction.V1.PredictionResultsSettled do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.PredictionResultsSettled",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end
