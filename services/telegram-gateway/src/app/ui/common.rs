use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup};

pub fn back_button() -> InlineKeyboardButton {
    InlineKeyboardButton::callback("◀️ Назад", "back")
}

pub fn cancel_button() -> InlineKeyboardButton {
    InlineKeyboardButton::callback("❌ Отмена", "cancel")
}

pub fn back_to_menu_button() -> InlineKeyboardButton {
    InlineKeyboardButton::callback("🏠 Главное меню", "back_to_start")
}

pub fn build_back_to_menu_keyboard() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::default().append_row(vec![back_to_menu_button()])
}

pub fn build_main_menu() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::default().append_row(vec![InlineKeyboardButton::callback(
        "🎪 Аукционы",
        "show_auction",
    )])
}

pub fn build_admin_main_menu() -> InlineKeyboardMarkup {
    InlineKeyboardMarkup::default()
        .append_row(vec![InlineKeyboardButton::callback(
            "🎪 Аукционы",
            "show_auction",
        )])
        .append_row(vec![InlineKeyboardButton::callback(
            "🔧 Управление аукционами",
            "admin:manage_auctions",
        )])
}
