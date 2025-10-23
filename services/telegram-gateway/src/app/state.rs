use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub enum State {
    #[default]
    Idle,
    WaitingForBidAmount {
        lot_id: u32,
    },
}
