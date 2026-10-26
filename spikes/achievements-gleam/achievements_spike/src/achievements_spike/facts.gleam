//// Факты аукциона как суммарные типы Gleam над ручным слоем wire.

import achievements_spike/wire

pub type LotOccasion {
  LotDrafted
  LotScheduled
  LotOpened
  BidPlaced(bidder_id: String)
  AskAdvanced
  DeadlineExtended
  LotSold
  LotUnsold
  LotWithdrawn
  LotHeldForFinal
  LotResumed
  StepWindowAdded
  ParticipantRemoved
  /// Номер oneof, которого этот читатель не знает: новый повод модуля.
  UnknownLotOccasion
}

pub type LotEvent {
  LotEvent(event_id: String, lot_id: String, version: Int, occasion: LotOccasion)
}

pub type InvoiceOccasion {
  InvoiceIssued
  InvoicePaid
  InvoiceHandedOver
  UnknownInvoiceOccasion
}

pub type InvoiceEvent {
  InvoiceEvent(
    event_id: String,
    invoice_id: String,
    auction_id: String,
    lot_id: String,
    winner_id: String,
    occasion: InvoiceOccasion,
  )
}

pub fn decode_lot_event(bytes: BitArray) -> Result(LotEvent, String) {
  case wire.fields(bytes) {
    Error(e) -> Error(e)
    Ok(fs) -> {
      let numbers = [15, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18]
      let occasion = case wire.oneof(fs, numbers) {
        Ok(15) -> LotDrafted
        Ok(16) -> LotScheduled
        Ok(6) -> LotOpened
        // Ставивший — новый лидер снимка: state(5).trading(10).leader_id(3).
        Ok(7) -> BidPlaced(bidder_id: leader(wire.message(fs, 5)))
        Ok(8) -> AskAdvanced
        Ok(9) -> DeadlineExtended
        Ok(10) -> LotSold
        Ok(11) -> LotUnsold
        Ok(12) -> LotWithdrawn
        Ok(13) -> LotHeldForFinal
        Ok(14) -> LotResumed
        Ok(17) -> StepWindowAdded
        Ok(18) -> ParticipantRemoved
        _ -> UnknownLotOccasion
      }
      Ok(LotEvent(
        event_id: wire.string(fs, 1),
        lot_id: wire.string(fs, 2),
        version: wire.int(fs, 3),
        occasion: occasion,
      ))
    }
  }
}

fn leader(state: List(wire.Field)) -> String {
  wire.string(wire.message(state, 10), 3)
}

pub fn decode_invoice_event(bytes: BitArray) -> Result(InvoiceEvent, String) {
  case wire.fields(bytes) {
    Error(e) -> Error(e)
    Ok(fs) -> {
      let state = wire.message(fs, 5)
      let occasion = case wire.oneof(fs, [6, 7, 8]) {
        Ok(6) -> InvoiceIssued
        Ok(7) -> InvoicePaid
        Ok(8) -> InvoiceHandedOver
        _ -> UnknownInvoiceOccasion
      }
      Ok(InvoiceEvent(
        event_id: wire.string(fs, 1),
        invoice_id: wire.string(fs, 2),
        auction_id: wire.string(state, 2),
        lot_id: wire.string(state, 3),
        winner_id: wire.string(state, 4),
        occasion: occasion,
      ))
    }
  }
}

/// Пример исчерпывающего разбора: каждый повод лота назван.
pub fn describe(o: LotOccasion) -> String {
  case o {
    LotDrafted -> "drafted"
    LotScheduled -> "scheduled"
    LotOpened -> "opened"
    BidPlaced(_) -> "bid"
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
