pub mod admin;
pub mod auction;
pub mod start;

use crate::app::state::State;
use teloxide::dispatching::dialogue::{Dialogue, InMemStorage};

pub type MyDialogue = Dialogue<State, InMemStorage<State>>;

pub use admin::{
    cancel_lot_creation_handler, confirm_lot_creation_handler, receive_lot_description_handler,
    receive_lot_image_url_handler, receive_lot_min_bid_step_handler,
    receive_lot_starting_price_handler, receive_lot_title_handler, skip_image_handler,
    start_lot_creation_handler,
};
pub use auction::{
    back_to_start_handler, bid_increase_handler, bid_start_handler, receive_bid_amount,
    set_bid_handler, show_auction_handler, show_description_handler, show_user_bids_handler,
    view_lot_handler,
};
pub use start::{auction_info_handler, handle_unknown_message_handler, start_handler};
