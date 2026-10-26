//// Факты, которые читают правила. Значения строит Elixir-адаптер
//// (`AchievementsReal.Facts`) из структур protobuf: имена конструкторов
//// поводов совпадают с тегами oneof Elixir protobuf, `LotSold` — `:lot_sold`.

import gleam/option.{type Option}

pub type LotOccasion {
  LotDrafted
  LotScheduled
  LotOpened
  BidPlaced
  AskAdvanced
  DeadlineExtended
  LotSold
  LotUnsold
  LotWithdrawn
  LotHeldForFinal
  LotResumed
  StepWindowAdded
  ParticipantRemoved
  UnknownLotOccasion
}

pub type InvoiceOccasion {
  InvoiceIssued
  InvoicePaid
  InvoiceHandedOver
  UnknownInvoiceOccasion
}

pub type Fact {
  Invoice(event_id: String, winner_id: String, occasion: InvoiceOccasion)
  Lot(event_id: String, occasion: LotOccasion, leader: Option(String))
  Ignored
}

pub fn describe(o: LotOccasion) -> String {
  case o {
    LotDrafted -> "drafted"
    LotScheduled -> "scheduled"
    LotOpened -> "opened"
    BidPlaced -> "bid"
    AskAdvanced -> "ask"
    DeadlineExtended -> "extended"
    LotSold -> "sold"
    LotUnsold -> "unsold"
    LotWithdrawn -> "withdrawn"
    LotHeldForFinal -> "held"
    LotResumed -> "resumed"
    StepWindowAdded -> "step_window"
    ParticipantRemoved -> "participant_removed"
    UnknownLotOccasion -> "unknown"
  }
}
