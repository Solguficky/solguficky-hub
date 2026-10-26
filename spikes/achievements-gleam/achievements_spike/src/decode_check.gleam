//// gleam run -m decode_check: читает байты, закодированные python protobuf.

import achievements_spike/facts
import gleam/io
import gleam/string
import simplifile

pub fn main() -> Nil {
  let assert Ok(b) = simplifile.read_bits("../fixtures/lot_bid_placed.bin")
  io.println("bid_placed: " <> string.inspect(facts.decode_lot_event(b)))
  let assert Ok(b) = simplifile.read_bits("../fixtures/lot_sold.bin")
  io.println("lot_sold: " <> string.inspect(facts.decode_lot_event(b)))
  let assert Ok(b) = simplifile.read_bits("../fixtures/invoice_paid.bin")
  io.println("invoice_paid: " <> string.inspect(facts.decode_invoice_event(b)))
  let assert Ok(b) = simplifile.read_bits("../fixtures/lot_unknown_occasion.bin")
  io.println("unknown: " <> string.inspect(facts.decode_lot_event(b)))
}
