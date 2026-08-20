use telegram_gateway::config::get_configuration;
use telegram_gateway::run;
use tracing_subscriber::{EnvFilter, FmtSubscriber};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Инициализация логирования
    let subscriber = FmtSubscriber::builder()
        .with_env_filter(EnvFilter::from_default_env())
        .json()
        .finish();
    tracing::subscriber::set_global_default(subscriber)
        .expect("Failed to set global default subscriber");

    // Загрузка конфигурации
    let settings = get_configuration().expect("Failed to read configuration.");
    tracing::info!("Configuration loaded: {:?}", settings);

    run().await?;

    Ok(())
}
