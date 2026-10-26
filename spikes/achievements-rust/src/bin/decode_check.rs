//! Пункт 1: байты python protobuf -> prost; неизвестное поле oneof.
use achievements_spike::facts::{self, pb};
use prost::Message;

fn main() {
    for (name, subject) in [
        ("lot_bid_placed", "events.auction.bid_placed"),
        ("lot_sold", "events.auction.lot_sold"),
        ("invoice_paid", "events.auction.invoice_paid"),
        ("lot_unknown_occasion", "events.auction.bid_placed"),
    ] {
        let bytes = std::fs::read(format!("fixtures/{name}.bin")).unwrap();
        let lot = pb::LotEvent::decode(bytes.as_slice());
        let fact = facts::decode(subject, &bytes);
        match name {
            "invoice_paid" => {
                let e = pb::InvoiceEvent::decode(bytes.as_slice()).unwrap();
                println!("{name}: event_id={} winner={} occasion={:?} reencode_equal={}",
                    e.event_id, e.state.as_ref().unwrap().winner_id, e.occasion, e.encode_to_vec() == bytes);
                println!("  rules: payer={:?}", fact.unwrap().payer());
            }
            _ => {
                let e = lot.unwrap();
                println!("{name}: event_id={} lot={} version={} occasion={:?} reencode_equal={}",
                    e.event_id, e.lot_id, e.version, e.occasion, e.encode_to_vec() == bytes);
                let f = fact.unwrap();
                println!("  rules: bidder={:?}", f.bidder());
            }
        }
    }
}
