use crate::domain::LotDto;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub enum State {
    #[default]
    Idle,
    WaitingForBidAmount {
        lot_id: u32,
    },
    CreatingLot {
        step: LotCreationStep,
        draft: LotDraft,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum LotCreationStep {
    EnteringTitle,
    EnteringDescription,
    EnteringStartingPrice,
    EnteringMinBidStep,
    EnteringImageUrl,
    ConfirmingDraft,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct LotDraft {
    pub title: Option<String>,
    pub description: Option<String>,
    pub starting_price: Option<f64>,
    pub min_bid_step: Option<f64>,
    pub image_url: Option<String>,
}

impl LotDraft {
    pub fn to_lot_dto(&self) -> LotDto {
        LotDto {
            id: 0,
            title: self.title.clone().unwrap_or_default(),
            description: self.description.clone().unwrap_or_default(),
            starting_price: self.starting_price.unwrap_or(0.0),
            min_bid_step: self.min_bid_step.unwrap_or(0.0),
            current_bid: None,
            current_bidder_id: None,
            image_url: self.image_url.clone().unwrap_or_default(),
        }
    }
}
