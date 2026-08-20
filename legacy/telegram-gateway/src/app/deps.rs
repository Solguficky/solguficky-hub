use crate::app::{auth, IdempotencyCache, UserRole};
use crate::config::Auth;
use crate::infra::{MockAuctionService, NatsClient};
use std::sync::Arc;
use std::time::Duration;
use teloxide::types::UserId;
use tracing::debug;

#[derive(Clone)]
pub struct Dependencies {
    pub nats: Arc<NatsClient>,
    pub auction_service: Arc<MockAuctionService>,
    pub idempotency: IdempotencyCache,
    pub auth_config: Auth,
}

impl Dependencies {
    pub fn new(nats: NatsClient, auction_service: MockAuctionService, auth_config: Auth) -> Self {
        Self {
            nats: Arc::new(nats),
            auction_service: Arc::new(auction_service),
            idempotency: IdempotencyCache::new(Duration::from_secs(3600)),
            auth_config,
        }
    }

    pub fn get_user_role(&self, user_id: UserId) -> UserRole {
        let role = auth::get_user_role(user_id, &self.auth_config);
        debug!(
            user_id = %user_id,
            role = ?role,
            "User role resolved"
        );
        role
    }
}
