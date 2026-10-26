//! Процесс сервиса: акторы ачивок под наблюдателями, релей outbox и gRPC health.
//! usage: serve collector,first_bidder,bidder
use achievements_spike::{actor, rules::Achievement, store};
use sqlx::PgPool;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let codes: Vec<&'static str> = std::env::args().nth(1).unwrap_or("collector,first_bidder,bidder".into())
        .leak().split(',').collect();
    let pool = PgPool::connect(&std::env::var("DATABASE_URL")
        .unwrap_or("postgres://postgres:spike@127.0.0.1:5433/postgres".into())).await?;
    store::init(&pool).await?;
    let js = async_nats::jetstream::new(async_nats::connect(
        std::env::var("NATS_URL").unwrap_or("127.0.0.1:4223".into())).await?);
    for c in &codes {
        let a = Achievement::by_code(c).ok_or_else(|| anyhow::anyhow!("unknown achievement {c}"))?;
        actor::supervise(a, js.clone(), pool.clone());
    }
    let relay_pool = pool.clone();
    let relay_codes = codes.clone();
    tokio::spawn(async move {
        loop {
            match store::relay(&relay_pool, &relay_codes).await {
                Ok(ready) => for (occ, seq, items) in ready { println!("announce occasion seq {seq} {occ} -> {items:?}"); },
                Err(e) => eprintln!("relay: {e}"),
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });

    let (reporter, health) = tonic_health::server::health_reporter();
    reporter.set_service_status("", tonic_health::ServingStatus::Serving).await;
    let addr = std::env::var("GRPC_ADDR").unwrap_or("0.0.0.0:50071".into()).parse()?;
    println!("grpc health on {addr}");
    tonic::transport::Server::builder().add_service(health).serve(addr).await?;
    Ok(())
}
