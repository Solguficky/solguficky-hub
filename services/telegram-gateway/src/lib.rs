pub mod app;
pub mod config;
pub mod domain;
pub mod generated;
pub mod helpers;
pub mod infra;

use app::{
    handlers::MyDialogue, start_event_listener, start_send_message_listener,
    state::LotCreationStep, wrappers::*, Command, Dependencies, State, UserRole,
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

fn admin_only(q: CallbackQuery, deps: Dependencies) -> bool {
    deps.get_user_role(q.from.id) == UserRole::Admin
}

pub async fn run() -> anyhow::Result<()> {
    let settings = get_configuration()?;
    info!("Starting Telegram Gateway...");

    let nats_client = NatsClient::connect(&settings.nats.url).await?;
    let auction_service = MockAuctionService::new();
    let deps = Dependencies::new(nats_client, auction_service, settings.auth.clone());

    let bot = Bot::new(&settings.telegram.token);

    info!("Starting background event listeners...");
    let nats_for_events = NatsClient::connect(&settings.nats.url).await?;
    let nats_for_messages = NatsClient::connect(&settings.nats.url).await?;
    start_event_listener(bot.clone(), nats_for_events).await?;
    start_send_message_listener(bot.clone(), nats_for_messages).await?;

    info!("Creating dispatcher...");

    let handler = dialogue::enter::<Update, InMemStorage<State>, State, _>()
        // Commands
        .branch(
            Update::filter_message()
                .filter_command::<Command>()
                .endpoint(start_wrapper),
        )
        // Message handlers for FSM states
        .branch(
            Update::filter_message()
                .enter_dialogue::<Message, InMemStorage<State>, State>()
                .branch(
                    dptree::case![State::WaitingForBidAmount { lot_id }]
                        .endpoint(receive_bid_amount_wrapper),
                )
                .branch(dptree::case![State::CreatingLot { step, draft }].endpoint(
                    |msg: Message, dialogue: MyDialogue, state: State, bot: Bot| async move {
                        if let State::CreatingLot { step, .. } = state {
                            match step {
                                LotCreationStep::EnteringTitle => {
                                    receive_lot_title_wrapper(msg, dialogue, bot).await
                                }
                                LotCreationStep::EnteringDescription => {
                                    receive_lot_description_wrapper(msg, dialogue, bot).await
                                }
                                LotCreationStep::EnteringStartingPrice => {
                                    receive_lot_starting_price_wrapper(msg, dialogue, bot).await
                                }
                                LotCreationStep::EnteringMinBidStep => {
                                    receive_lot_min_bid_step_wrapper(msg, dialogue, bot).await
                                }
                                LotCreationStep::EnteringImageUrl => {
                                    receive_lot_image_url_wrapper(msg, dialogue, bot).await
                                }
                                LotCreationStep::ConfirmingDraft => Ok(()),
                            }
                        } else {
                            Ok(())
                        }
                    },
                )),
        )
        // Callback query handlers - генерируются макросом callback_routes!
        .branch(
            Update::filter_callback_query()
                .branch(callback_routes! {
                    "show_auction" => show_auction_wrapper,
                    "admin:manage_auctions" => show_auction_wrapper [admin_only],
                    "view_lot:" => view_lot_wrapper,
                    "show_description:" => show_description_wrapper,
                    "bid_start:" => bid_start_wrapper,
                    "bid_increase:" => bid_increase_wrapper,
                    "set_bid:" => set_bid_wrapper,
                    "back_to_start" => back_to_start_wrapper,
                    "admin:add_lot" => start_lot_creation_wrapper [admin_only],
                    "admin:skip_image" => skip_image_wrapper [admin_only],
                    "admin:confirm_lot" => confirm_lot_creation_wrapper [admin_only],
                })
                .branch(
                    dptree::filter(|q: CallbackQuery| {
                        q.data.as_deref() == Some("cancel")
                            || q.data.as_deref() == Some("admin:cancel_lot")
                    })
                    .endpoint(cancel_lot_creation_wrapper),
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
