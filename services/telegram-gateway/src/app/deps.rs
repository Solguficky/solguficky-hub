use crate::app::IdempotencyCache;
use crate::infra::{MockAuctionService, NatsClient};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct Dependencies {
    pub nats: Arc<NatsClient>,
    pub auction_service: Arc<MockAuctionService>,
    pub idempotency: IdempotencyCache,
}

impl Dependencies {
    pub fn new(nats: NatsClient, auction_service: MockAuctionService) -> Self {
        Self {
            nats: Arc::new(nats),
            auction_service: Arc::new(auction_service),
            idempotency: IdempotencyCache::new(Duration::from_secs(3600)),
        }
    }
}

