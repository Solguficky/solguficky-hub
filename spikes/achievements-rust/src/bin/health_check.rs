//! Клиент grpc.health.v1.Health/Check — вместо grpcurl, которого в среде нет.
use tonic_health::pb::{health_client::HealthClient, HealthCheckRequest};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let addr = std::env::args().nth(1).unwrap_or("http://127.0.0.1:50071".into());
    let ch = tonic::transport::Endpoint::from_shared(addr.clone())?.connect().await?;
    let mut c = HealthClient::new(ch);
    let r = c.check(HealthCheckRequest { service: String::new() }).await?;
    println!("{addr} grpc.health.v1.Health/Check -> {:?}", r.into_inner().status());
    Ok(())
}
