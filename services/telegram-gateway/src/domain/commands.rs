use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaceBidCommand {
    pub op_id: Uuid,
    pub event_id: String,
    pub lot_id: u32,
    pub user_id: i64,
    pub amount: f64,
}

impl PlaceBidCommand {
    pub fn new(event_id: String, lot_id: u32, user_id: i64, amount: f64) -> Self {
        Self {
            op_id: Uuid::new_v4(),
            event_id,
            lot_id,
            user_id,
            amount,
        }
    }
}

