use crate::app::ui::{common, user};
use crate::domain::AuctionDto;
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup};

pub fn build_admin_auction_view(auction: &AuctionDto) -> (String, InlineKeyboardMarkup) {
    let (text, mut keyboard) = user::build_auction_list(auction);

    keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
        "➕ Добавить лот",
        "admin:add_lot",
    )]);

    keyboard = keyboard.append_row(vec![common::back_to_menu_button()]);

    (text, keyboard)
}
