/// MVP: Single hardcoded auction ID (canonical UUIDv7 string, ADR-020)
///
/// For MVP, we use a single auction with a hardcoded ID.
/// In the future, this will be generated dynamically when creating auctions
/// via `uuid::Uuid::now_v7()`.
pub const AUCTION_ID: &str = "019f731a-86ac-7f29-8ada-2a5966ab7097";
