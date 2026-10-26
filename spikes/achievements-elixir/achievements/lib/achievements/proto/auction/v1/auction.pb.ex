defmodule Auction.V1.LotPhase do
  @moduledoc false

  use Protobuf,
    enum: true,
    full_name: "auction.v1.LotPhase",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :LOT_PHASE_UNSPECIFIED, 0
  field :LOT_PHASE_ONLINE, 1
  field :LOT_PHASE_LIVE, 2
end

defmodule Auction.V1.UnsoldReason do
  @moduledoc false

  use Protobuf,
    enum: true,
    full_name: "auction.v1.UnsoldReason",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :UNSOLD_REASON_UNSPECIFIED, 0
  field :UNSOLD_REASON_NO_BIDS, 1
end

defmodule Auction.V1.WithdrawnReason do
  @moduledoc false

  use Protobuf,
    enum: true,
    full_name: "auction.v1.WithdrawnReason",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :WITHDRAWN_REASON_UNSPECIFIED, 0
  field :WITHDRAWN_REASON_BY_ORGANIZER, 1
  field :WITHDRAWN_REASON_BY_AUTHOR, 2
  field :WITHDRAWN_REASON_DUPLICATE, 3
  field :WITHDRAWN_REASON_AUCTION_CANCELLED, 4
end

defmodule Auction.V1.BidSource do
  @moduledoc false

  use Protobuf,
    enum: true,
    full_name: "auction.v1.BidSource",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :BID_SOURCE_UNSPECIFIED, 0
  field :BID_SOURCE_BOT, 1
  field :BID_SOURCE_FLOOR, 2
end

defmodule Auction.V1.PredictionNomination do
  @moduledoc false

  use Protobuf,
    enum: true,
    full_name: "auction.v1.PredictionNomination",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :PREDICTION_NOMINATION_UNSPECIFIED, 0
  field :PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT, 1
  field :PREDICTION_NOMINATION_TOTAL_SALES, 2
  field :PREDICTION_NOMINATION_MOST_BIDS_LOT, 3
  field :PREDICTION_NOMINATION_BIGGEST_GROWTH_LOT, 4
  field :PREDICTION_NOMINATION_MOST_BIDDERS_LOT, 5
  field :PREDICTION_NOMINATION_TOTAL_BIDS, 6
  field :PREDICTION_NOMINATION_FINAL_MOST_EXPENSIVE_LOT, 7
  field :PREDICTION_NOMINATION_FINAL_TOTAL_SALES, 8
  field :PREDICTION_NOMINATION_FINAL_BIGGEST_GROWTH_LOT, 9
  field :PREDICTION_NOMINATION_FINAL_TOTAL_BIDS, 10
end

defmodule Auction.V1.FulfillmentMethod do
  @moduledoc false

  use Protobuf,
    enum: true,
    full_name: "auction.v1.FulfillmentMethod",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :FULFILLMENT_METHOD_UNSPECIFIED, 0
  field :FULFILLMENT_METHOD_PICKUP, 1
  field :FULFILLMENT_METHOD_DELIVERY, 2
  field :FULFILLMENT_METHOD_DIGITAL, 3
end

defmodule Auction.V1.Money do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.Money",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :minor_units, 1, type: :int64, json_name: "minorUnits"
  field :currency, 2, type: :string
end

defmodule Auction.V1.LotConfig do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotConfig",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :currency, 1, type: :string
  field :step_policy, 2, type: Auction.V1.StepPolicy, json_name: "stepPolicy"
  field :anti_snipe, 3, type: Auction.V1.AntiSnipe, json_name: "antiSnipe"
  field :proxy_enabled, 4, type: :bool, json_name: "proxyEnabled"
end

defmodule Auction.V1.StepPolicy do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.StepPolicy",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :policy, 0

  field :fixed, 1, type: Auction.V1.Money, oneof: 0
  field :tiered, 2, type: Auction.V1.TieredSteps, oneof: 0
end

defmodule Auction.V1.TieredSteps do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.TieredSteps",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :tiers, 1, repeated: true, type: Auction.V1.StepTier
end

defmodule Auction.V1.StepTier do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.StepTier",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :lower_bound, 1, type: Auction.V1.Money, json_name: "lowerBound"
  field :step, 2, type: Auction.V1.Money
end

defmodule Auction.V1.AntiSnipe do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AntiSnipe",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :window_seconds, 1, type: :int64, json_name: "windowSeconds"
  field :extension_seconds, 2, type: :int64, json_name: "extensionSeconds"
  field :max_extensions, 3, type: :int32, json_name: "maxExtensions"
end

defmodule Auction.V1.LotDraft do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotDraft",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.LotSchedule do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotSchedule",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :starting_price, 1, type: Auction.V1.Money, json_name: "startingPrice"
end

defmodule Auction.V1.LotTrading do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotTrading",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :current_price, 1, type: Auction.V1.Money, json_name: "currentPrice"
  field :ask, 2, type: Auction.V1.Money
  field :leader_id, 3, proto3_optional: true, type: :string, json_name: "leaderId"
  field :leading_bid_id, 4, proto3_optional: true, type: :string, json_name: "leadingBidId"
  field :deadline, 5, proto3_optional: true, type: :string
  field :extensions_used, 6, type: :int32, json_name: "extensionsUsed"
  field :phase, 7, type: Auction.V1.LotPhase, enum: true
end

defmodule Auction.V1.LotHeld do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotHeld",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :current_price, 1, type: Auction.V1.Money, json_name: "currentPrice"
  field :leader_id, 2, proto3_optional: true, type: :string, json_name: "leaderId"
  field :leading_bid_id, 3, proto3_optional: true, type: :string, json_name: "leadingBidId"
  field :extensions_used, 4, type: :int32, json_name: "extensionsUsed"
end

defmodule Auction.V1.LotSale do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotSale",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :winner_id, 1, type: :string, json_name: "winnerId"
  field :price, 2, type: Auction.V1.Money
  field :bid_id, 3, type: :string, json_name: "bidId"
  field :sold_at, 4, type: :string, json_name: "soldAt"
end

defmodule Auction.V1.AuctionConfig do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionConfig",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :online_phase, 1, type: Auction.V1.OnlinePhase, json_name: "onlinePhase"
  field :final_blocks, 2, type: :int32, json_name: "finalBlocks"
  field :closing_policy, 3, type: Auction.V1.ClosingPolicy, json_name: "closingPolicy"
  field :lot_defaults, 4, type: Auction.V1.LotDefaults, json_name: "lotDefaults"

  field :step_windows, 5,
    repeated: true,
    type: Auction.V1.AuctionStepWindow,
    json_name: "stepWindows"

  field :payment_term_seconds, 6,
    proto3_optional: true,
    type: :int64,
    json_name: "paymentTermSeconds"
end

defmodule Auction.V1.AuctionStepWindow do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.AuctionStepWindow",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :from, 1, type: :string
  field :until, 2, type: :string
  field :step, 3, type: Auction.V1.Money
  field :lot_ids, 4, repeated: true, type: :string, json_name: "lotIds"
end

defmodule Auction.V1.OnlinePhase do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.OnlinePhase",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :opens_at, 1, type: :string, json_name: "opensAt"
  field :closes_at, 2, proto3_optional: true, type: :string, json_name: "closesAt"
  field :closes_lots, 3, type: :bool, json_name: "closesLots"
  field :raffle_closes_at, 4, proto3_optional: true, type: :string, json_name: "raffleClosesAt"
  field :raffle_prize, 5, proto3_optional: true, type: :string, json_name: "rafflePrize"
end

defmodule Auction.V1.ClosingPolicy do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.ClosingPolicy",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  oneof :policy, 0

  field :by_auctioneer, 1,
    type: Auction.V1.ClosingByAuctioneer,
    json_name: "byAuctioneer",
    oneof: 0

  field :by_deadline, 2, type: Auction.V1.ClosingByDeadline, json_name: "byDeadline", oneof: 0
  field :mixed, 3, type: Auction.V1.MixedClosing, oneof: 0
end

defmodule Auction.V1.ClosingByAuctioneer do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.ClosingByAuctioneer",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.ClosingByDeadline do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.ClosingByDeadline",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3
end

defmodule Auction.V1.MixedClosing do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.MixedClosing",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :online_by_deadline, 1, type: :bool, json_name: "onlineByDeadline"
end

defmodule Auction.V1.LotDefaults do
  @moduledoc false

  use Protobuf,
    full_name: "auction.v1.LotDefaults",
    protoc_gen_elixir_version: "0.17.1",
    syntax: :proto3

  field :currency, 1, type: :string
  field :step_policy, 2, type: Auction.V1.StepPolicy, json_name: "stepPolicy"
  field :anti_snipe, 3, type: Auction.V1.AntiSnipe, json_name: "antiSnipe"
  field :proxy_enabled, 4, type: :bool, json_name: "proxyEnabled"
end
