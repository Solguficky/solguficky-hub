use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BidInfo {
    pub user_id: i64,
    pub amount: f64,
    pub timestamp: i64,
}

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
    pub bids: Vec<BidInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuctionDto {
    pub auction_id: String,
    pub auction_name: String,
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
