//// Ачивки — единицы кода: определение и правило над фактами модуля.

import achievements_spike/facts
import achievements_spike/store
import gleam/option.{None, Some}

pub type Fact {
  Invoice(facts.InvoiceEvent)
  Lot(facts.LotEvent)
  /// Факт, которого правила не читают: курсор всё равно идёт вперёд.
  Ignored
}

pub type Achievement {
  Achievement(
    code: String,
    title: String,
    single: Bool,
    /// Исполняется внутри транзакции факта; отдаёт субъектов к выдаче.
    rule: fn(Fact) -> List(String),
  )
}

pub fn decode(subject: String, body: BitArray) -> Result(Fact, String) {
  case subject {
    "events.auction.invoice_paid" ->
      case facts.decode_invoice_event(body) {
        Ok(e) -> Ok(Invoice(e))
        Error(e) -> Error(e)
      }
    "events.auction.bid_placed" ->
      case facts.decode_lot_event(body) {
        Ok(e) -> Ok(Lot(e))
        Error(e) -> Error(e)
      }
    _ -> Ok(Ignored)
  }
}

pub fn event_id(fact: Fact) -> Result(String, Nil) {
  case fact {
    Invoice(e) -> Ok(e.event_id)
    Lot(e) -> Ok(e.event_id)
    Ignored -> Error(Nil)
  }
}

/// «Коллекционер»: оплатил три лота. Состояние — число оплат субъекта.
pub fn collector() -> Achievement {
  let code = "collector"
  Achievement(code:, title: "Коллекционер", single: False, rule: fn(fact) {
    case fact {
      Invoice(facts.InvoiceEvent(occasion: facts.InvoicePaid, winner_id: w, ..)) -> {
        let n = store.count(code, w) + 1
        store.put_count(code, w, n)
        case n == 3 {
          True -> [w]
          False -> []
        }
      }
      _ -> []
    }
  })
}

/// «Первый ставочник»: первая ставка в стриме, один получатель на ачивку.
pub fn first_bidder() -> Achievement {
  let code = "first_bidder"
  Achievement(code:, title: "Первый ставочник", single: True, rule: fn(fact) {
    case fact {
      Lot(facts.LotEvent(occasion: facts.BidPlaced(bidder), ..)) ->
        case store.single_holder(code) {
          None -> [bidder]
          Some(_) -> []
        }
      _ -> []
    }
  })
}

/// «Ставочник»: сделал ставку. Первая ставка в стриме даёт его вместе с
/// «Первым ставочником» — два актора, один повод: проверка ADR-077 п.8.
pub fn bidder() -> Achievement {
  Achievement(code: "bidder", title: "Ставочник", single: False, rule: fn(fact) {
    case fact {
      Lot(facts.LotEvent(occasion: facts.BidPlaced(bidder), ..)) -> [bidder]
      _ -> []
    }
  })
}

/// «Первая покупка»: оплатил лот. Добавляется после обработки — дочитывает стрим.
pub fn first_payment() -> Achievement {
  Achievement(code: "first_payment", title: "Первая покупка", single: False, rule: fn(
    fact,
  ) {
    case fact {
      Invoice(facts.InvoiceEvent(occasion: facts.InvoicePaid, winner_id: w, ..)) -> [
        w,
      ]
      _ -> []
    }
  })
}
