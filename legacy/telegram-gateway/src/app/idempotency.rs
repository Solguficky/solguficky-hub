use dashmap::DashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, info};

pub struct IdempotencyCache {
    cache: Arc<DashSet<(String, Instant)>>,
    ttl: Duration,
}

impl IdempotencyCache {
    pub fn new(ttl: Duration) -> Self {
        let cache = Arc::new(DashSet::new());
        let cache_clone = cache.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                Self::cleanup(&cache_clone);
            }
        });

        Self { cache, ttl }
    }

    pub fn check_and_insert(&self, id: String) -> bool {
        let now = Instant::now();

        if self.cache.iter().any(|entry| entry.0 == id) {
            debug!(request_id = %id, "Idempotency check: duplicate request detected");
            return false;
        }

        self.cache.insert((id.clone(), now));
        debug!(request_id = %id, cache_size = self.cache.len(), "Idempotency check: new request, added to cache");
        true
    }

    fn cleanup(cache: &DashSet<(String, Instant)>) {
        let now = Instant::now();
        let initial_size = cache.len();
        cache.retain(|(_, timestamp)| now.duration_since(*timestamp) < Duration::from_secs(3600));
        let removed = initial_size.saturating_sub(cache.len());

        if removed > 0 {
            info!(
                removed_entries = removed,
                remaining_entries = cache.len(),
                "Idempotency cache cleanup completed"
            );
        }
    }
}

impl Clone for IdempotencyCache {
    fn clone(&self) -> Self {
        Self {
            cache: self.cache.clone(),
            ttl: self.ttl,
        }
    }
}
