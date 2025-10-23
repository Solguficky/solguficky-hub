use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BidPlacedEvent {
    pub event_id: String,
    pub lot_id: u32,
    pub user_id: i64,
    pub amount: f64,
    pub previous_leader_id: Option<i64>,
    pub current_leader_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuctionFinishedEvent {
    pub event_id: String,
    pub lot_id: u32,
    pub winner_id: i64,
    pub final_amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageCommand {
    pub user_id: i64,
    pub text: String,
}

