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
    InlineKeyboardMarkup::default()
        .append_row(vec![InlineKeyboardButton::callback(
            "🎪 Аукционы",
            "show_auction",
        )])
        .append_row(vec![InlineKeyboardButton::callback(
            "📊 Мои ставки",
            "show_user_bids",
        )])
        .append_row(vec![InlineKeyboardButton::callback(
            "❓ Как это работает?",
            "auction_info",
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

pub fn build_auction_info() -> (String, InlineKeyboardMarkup) {
    let text = "Добро пожаловать на аукцион платформы Solguficky! 🎪\n\n\
        📋 Как работает бот:\n\n\
        • Используйте кнопку '🎪 Аукционы' для просмотра доступных лотов\n\
        • В списке лотов выберите интересующий вас лот\n\
        • Вы можете посмотреть описание, фото и текущую ставку\n\
        • Сделайте ставку одним из способов:\n\
          - Начать торги (если вы первый) по стартовой цене\n\
          - Повысить на минимальный шаг\n\
          - Указать индивидуальную сумму\n\n\
        📊 Отслеживайте свои ставки через '📊 Мои ставки'\n\n\
        ⏰ Торги проходят в формате непрерывного аукциона\n\
        💰 Все ставки принимаются в рублях\n\
        🏆 Выигрывает последняя принятая ставка\n\n\
        Если у вас есть вопросы - обращайтесь к организаторам!";

    let keyboard = InlineKeyboardMarkup::default()
        .append_row(vec![InlineKeyboardButton::url(
            "❓ Задать вопрос",
            "https://t.me/Neptunini".parse().unwrap(),
        )])
        .append_row(vec![back_to_menu_button()]);

    (text.to_string(), keyboard)
}

pub fn build_unknown_message_prompt() -> (String, InlineKeyboardMarkup) {
    let text = "Кажется, что-то пошло не так, или вы тут впервые 🤔\n\n\
        Объяснить как работает бот?";

    let keyboard = InlineKeyboardMarkup::default().append_row(vec![
        InlineKeyboardButton::callback("✅ Да, объяснить", "auction_info"),
        InlineKeyboardButton::callback("❌ Нет, не надо", "back_to_start"),
    ]);

    (text.to_string(), keyboard)
}
