//// Ачивки — чистое ядро на Gleam: правило получает факт и чтения состояния,
//// возвращает решение. Транзакцию, NATS и PG держит Elixir-оболочка.

import achievements_real/facts.{type Fact, Invoice, Lot}
import gleam/list
import gleam/option.{Some}

/// Чтения состояния внутри транзакции факта; их даёт оболочка.
pub type Reads {
  Reads(count: fn(String) -> Int, single_taken: fn() -> Bool)
}

pub type Decision {
  Decision(grants: List(String), counts: List(#(String, Int)))
}

pub type Achievement {
  Achievement(
    code: String,
    title: String,
    single: Bool,
    rule: fn(Fact, Reads) -> Decision,
  )
}

const nothing = Decision(grants: [], counts: [])

pub fn all() -> List(Achievement) {
  [
    Achievement("collector", "Коллекционер", False, collector),
    Achievement("first_bidder", "Первый ставочник", True, first_bidder),
    Achievement("bidder", "Ставочник", False, bidder),
    Achievement("first_payment", "Первая покупка", False, first_payment),
  ]
}

pub fn find(code: String) -> Result(Achievement, Nil) {
  list.find(all(), fn(a) { a.code == code })
}

/// «Коллекционер»: оплатил три лота.
fn collector(fact: Fact, reads: Reads) -> Decision {
  case fact {
    Invoice(occasion: facts.InvoicePaid, winner_id: w, ..) -> {
      let n = reads.count(w) + 1
      Decision(
        grants: case n == 3 {
          True -> [w]
          False -> []
        },
        counts: [#(w, n)],
      )
    }
    _ -> nothing
  }
}

/// «Первый ставочник»: первая ставка в стриме, один получатель.
fn first_bidder(fact: Fact, reads: Reads) -> Decision {
  case fact {
    Lot(occasion: facts.BidPlaced, leader: Some(b), ..) ->
      case reads.single_taken() {
        True -> nothing
        False -> Decision(..nothing, grants: [b])
      }
    _ -> nothing
  }
}

/// «Ставочник»: сделал ставку.
fn bidder(fact: Fact, _reads: Reads) -> Decision {
  case fact {
    Lot(occasion: facts.BidPlaced, leader: Some(b), ..) ->
      Decision(..nothing, grants: [b])
    _ -> nothing
  }
}

/// «Первая покупка»: оплатил лот; добавляется позже и дочитывает стрим.
fn first_payment(fact: Fact, _reads: Reads) -> Decision {
  case fact {
    Invoice(occasion: facts.InvoicePaid, winner_id: w, ..) ->
      Decision(..nothing, grants: [w])
    _ -> nothing
  }
}
