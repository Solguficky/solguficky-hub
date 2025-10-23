pub mod app;
pub mod config;
pub mod domain;
pub mod generated;
pub mod infra;

use app::{
    back_to_start_handler, bid_increase_handler, bid_start_handler, receive_bid_amount,
    set_bid_handler, show_auction_handler, show_description_handler, start_event_listener,
    start_handler, start_send_message_listener, view_lot_handler, Command, Dependencies, State,
};
use config::get_configuration;
use infra::{MockAuctionService, NatsClient};
use teloxide::{
    dispatching::{
        dialogue::{self, InMemStorage},
        UpdateFilterExt,
    },
    dptree,
    prelude::*,
    types::Update,
};
use tracing::info;

pub async fn run() -> anyhow::Result<()> {
    let settings = get_configuration()?;
    info!("Starting Telegram Gateway...");

    let nats_client = NatsClient::connect(&settings.nats.url).await?;
    let auction_service = MockAuctionService::new();
    let deps = Dependencies::new(nats_client, auction_service);

    let bot = Bot::new(&settings.telegram.token);

    info!("Starting background event listeners...");
    let nats_for_events = NatsClient::connect(&settings.nats.url).await?;
    let nats_for_messages = NatsClient::connect(&settings.nats.url).await?;
    start_event_listener(bot.clone(), nats_for_events).await?;
    start_send_message_listener(bot.clone(), nats_for_messages).await?;

    info!("Creating dispatcher...");

    let handler = dialogue::enter::<Update, InMemStorage<State>, State, _>()
        .branch(
            Update::filter_message()
                .filter_command::<Command>()
                .endpoint(start_handler),
        )
        .branch(
            Update::filter_message()
                .enter_dialogue::<Message, InMemStorage<State>, State>()
                .branch(
                    dptree::case![State::WaitingForBidAmount { lot_id }]
                        .endpoint(receive_bid_amount),
                ),
        )
        .branch(
            Update::filter_callback_query()
                .branch(
                    dptree::filter(|q: CallbackQuery| {
                        q.data.as_ref().map(|d| d.as_str()) == Some("show_auction")
                    })
                    .endpoint(show_auction_handler),
                )
                .branch(
                    dptree::filter(|q: CallbackQuery| {
                        q.data
                            .as_ref()
                            .map(|d| d.starts_with("view_lot:"))
                            .unwrap_or(false)
                    })
                    .endpoint(view_lot_handler),
                )
                .branch(
                    dptree::filter(|q: CallbackQuery| {
                        q.data
                            .as_ref()
                            .map(|d| d.starts_with("show_description:"))
                            .unwrap_or(false)
                    })
                    .endpoint(show_description_handler),
                )
                .branch(
                    dptree::filter(|q: CallbackQuery| {
                        q.data
                            .as_ref()
                            .map(|d| d.starts_with("bid_start:"))
                            .unwrap_or(false)
                    })
                    .endpoint(bid_start_handler),
                )
                .branch(
                    dptree::filter(|q: CallbackQuery| {
                        q.data
                            .as_ref()
                            .map(|d| d.starts_with("bid_increase:"))
                            .unwrap_or(false)
                    })
                    .endpoint(bid_increase_handler),
                )
                .branch(
                    dptree::filter(|q: CallbackQuery| {
                        q.data
                            .as_ref()
                            .map(|d| d.starts_with("set_bid:"))
                            .unwrap_or(false)
                    })
                    .endpoint(set_bid_handler),
                )
                .branch(
                    dptree::filter(|q: CallbackQuery| {
                        q.data.as_ref().map(|d| d.as_str()) == Some("back_to_start")
                    })
                    .endpoint(back_to_start_handler),
                ),
        );

    info!("Starting dispatcher with graceful shutdown...");

    Dispatcher::builder(bot, handler)
        .dependencies(dptree::deps![InMemStorage::<State>::new(), deps])
        .enable_ctrlc_handler()
        .build()
        .dispatch()
        .await;

    info!("Telegram Gateway shut down gracefully");

    Ok(())
}
