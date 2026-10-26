//! Факты модуля аукциона: сгенерированные prost-типы и разбор по subject.
pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/auction.v1.rs"));
}
use pb::{invoice_event, lot_event, InvoiceEvent, LotEvent};
use prost::Message;

/// Факт, который читают правила. Остальные subject — `Ignored`: курсор идёт вперёд.
#[derive(Debug, Clone)]
pub enum Fact {
    Invoice(InvoiceEvent),
    Lot(LotEvent),
    Ignored,
}

pub fn decode(subject: &str, body: &[u8]) -> Result<Fact, prost::DecodeError> {
    Ok(match subject {
        "events.auction.invoice_paid" => Fact::Invoice(InvoiceEvent::decode(body)?),
        "events.auction.bid_placed" => Fact::Lot(LotEvent::decode(body)?),
        _ => Fact::Ignored,
    })
}

impl Fact {
    pub fn event_id(&self) -> Option<&str> {
        match self {
            Fact::Invoice(e) => Some(&e.event_id),
            Fact::Lot(e) => Some(&e.event_id),
            Fact::Ignored => None,
        }
    }
    /// Ставивший — лидер лота после ставки.
    pub fn bidder(&self) -> Option<&str> {
        match self {
            Fact::Lot(LotEvent { occasion: Some(lot_event::Occasion::BidPlaced(_)), state: Some(s), .. }) => {
                match &s.status {
                    Some(pb::lot_state::Status::Trading(t)) => t.leader_id.as_deref(),
                    _ => None,
                }
            }
            _ => None,
        }
    }
    pub fn payer(&self) -> Option<&str> {
        match self {
            Fact::Invoice(InvoiceEvent { occasion: Some(invoice_event::Occasion::InvoicePaid(_)), state: Some(s), .. }) => {
                Some(s.winner_id.as_str())
            }
            _ => None,
        }
    }
}
