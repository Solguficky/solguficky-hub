use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LotDto {
    pub id: u32,
    pub title: String,
    pub description: String,
    pub starting_price: f64,
    pub min_bid_step: f64,
    pub current_bid: Option<f64>,
    pub current_bidder_id: Option<i64>,
    pub image_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuctionDto {
    pub event_id: String,
    pub event_name: String,
    pub status: AuctionStatus,
    pub lots: Vec<LotDto>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuctionStatus {
    NotStarted,
    Running,
    Finished,
}
