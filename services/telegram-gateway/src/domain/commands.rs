use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaceBidCommand {
    pub op_id: Uuid,
    pub auction_id: String,
    pub lot_id: u32,
    pub user_id: i64,
    pub amount: f64,
}

impl PlaceBidCommand {
    pub fn new(auction_id: String, lot_id: u32, user_id: i64, amount: f64) -> Self {
        Self {
            op_id: Uuid::now_v7(),
            auction_id,
            lot_id,
            user_id,
            amount,
        }
    }
}
