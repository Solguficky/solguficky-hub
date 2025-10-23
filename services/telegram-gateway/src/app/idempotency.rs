use dashmap::DashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
            return false;
        }

        self.cache.insert((id, now));
        true
    }

    fn cleanup(cache: &DashSet<(String, Instant)>) {
        let now = Instant::now();
        cache.retain(|(_, timestamp)| now.duration_since(*timestamp) < Duration::from_secs(3600));
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

