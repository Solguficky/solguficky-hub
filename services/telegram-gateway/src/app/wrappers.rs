use crate::{
    app::{
        admin::{
            cancel_lot_creation_handler, confirm_lot_creation_handler,
            receive_lot_description_handler, receive_lot_image_url_handler,
            receive_lot_min_bid_step_handler, receive_lot_starting_price_handler,
            receive_lot_title_handler, skip_image_handler, start_lot_creation_handler,
        },
        auction_info_handler, back_to_start_handler, bid_increase_handler, bid_start_handler,
        handle_unknown_message_handler,
        handlers::MyDialogue,
        receive_bid_amount, set_bid_handler, show_auction_handler, show_description_handler,
        show_user_bids_handler, start_handler, view_lot_handler, Command, Dependencies, State,
    },
    wrap_handler,
};
use teloxide::prelude::*;

wrap_handler!(start_wrapper, start_handler(msg: Message, cmd: Command, deps: Dependencies));
wrap_handler!(show_auction_wrapper, show_auction_handler(q: CallbackQuery, deps: Dependencies));
wrap_handler!(show_user_bids_wrapper, show_user_bids_handler(q: CallbackQuery, deps: Dependencies));
wrap_handler!(auction_info_wrapper, auction_info_handler(q: CallbackQuery));
wrap_handler!(view_lot_wrapper, view_lot_handler(q: CallbackQuery, deps: Dependencies));
wrap_handler!(show_description_wrapper, show_description_handler(q: CallbackQuery, deps: Dependencies));
wrap_handler!(bid_start_wrapper, bid_start_handler(q: CallbackQuery, deps: Dependencies));
wrap_handler!(bid_increase_wrapper, bid_increase_handler(q: CallbackQuery, deps: Dependencies));
wrap_handler!(set_bid_wrapper, set_bid_handler(q: CallbackQuery, dialogue: MyDialogue));
wrap_handler!(receive_bid_amount_wrapper, receive_bid_amount(msg: Message, dialogue: MyDialogue, deps: Dependencies, state: State));
wrap_handler!(back_to_start_wrapper, back_to_start_handler(q: CallbackQuery, deps: Dependencies));
wrap_handler!(handle_unknown_message_wrapper, handle_unknown_message_handler(msg: Message));
wrap_handler!(start_lot_creation_wrapper, start_lot_creation_handler(q: CallbackQuery, dialogue: MyDialogue));
wrap_handler!(receive_lot_title_wrapper, receive_lot_title_handler(msg: Message, dialogue: MyDialogue));
wrap_handler!(receive_lot_description_wrapper, receive_lot_description_handler(msg: Message, dialogue: MyDialogue));
wrap_handler!(receive_lot_starting_price_wrapper, receive_lot_starting_price_handler(msg: Message, dialogue: MyDialogue));
wrap_handler!(receive_lot_min_bid_step_wrapper, receive_lot_min_bid_step_handler(msg: Message, dialogue: MyDialogue));
wrap_handler!(receive_lot_image_url_wrapper, receive_lot_image_url_handler(msg: Message, dialogue: MyDialogue));
wrap_handler!(skip_image_wrapper, skip_image_handler(q: CallbackQuery, dialogue: MyDialogue));
wrap_handler!(confirm_lot_creation_wrapper, confirm_lot_creation_handler(q: CallbackQuery, dialogue: MyDialogue, deps: Dependencies));
wrap_handler!(cancel_lot_creation_wrapper, cancel_lot_creation_handler(q: CallbackQuery, dialogue: MyDialogue));
