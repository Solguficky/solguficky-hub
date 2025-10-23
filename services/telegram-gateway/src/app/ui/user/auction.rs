use crate::app::ui::common;
use crate::domain::{AuctionDto, LotDto};
use crate::infra::UserBidSummary;
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup};

pub fn build_auction_list(auction: &AuctionDto) -> (String, InlineKeyboardMarkup) {
    let text = format!(
        "🎪 Аукцион: {}\n\nСтатус: {:?}\n\nДоступные лоты:",
        auction.event_name, auction.status
    );

    let mut keyboard = InlineKeyboardMarkup::default();

    for lot in auction.lots.iter() {
        keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
            format!("Лот {}: {}", lot.id, lot.title),
            format!("view_lot:{}", lot.id),
        )]);
    }

    keyboard = keyboard.append_row(vec![common::back_to_menu_button()]);

    (text, keyboard)
}

pub fn build_lot_view(lot: &LotDto) -> (String, InlineKeyboardMarkup) {
    let text = format!(
        "📦 Лот: {}\n\n\
        Текущая ставка: {}\n\n\
        Выберите действие:",
        lot.title,
        lot.current_bid
            .map(|b| format!("{} руб", b))
            .unwrap_or_else(|| "Нет ставок".to_string())
    );

    let mut keyboard = InlineKeyboardMarkup::default();

    keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
        "📖 Посмотреть описание",
        format!("show_description:{}", lot.id),
    )]);

    if let Some(current_bid) = lot.current_bid {
        let new_bid = current_bid + lot.min_bid_step;
        keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
            format!(
                "💰 Повысить на {} руб (новая ставка: {} руб)",
                lot.min_bid_step, new_bid
            ),
            format!("bid_increase:{}", lot.id),
        )]);
        keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
            format!("✏️ Индивидуальная ставка (>{})", lot.min_bid_step),
            format!("set_bid:{}", lot.id),
        )]);
    } else {
        keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
            format!("🎯 Начать торги за {} руб", lot.starting_price),
            format!("bid_start:{}", lot.id),
        )]);
    }

    keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
        "◀️ Назад к лотам",
        "show_auction",
    )]);

    (text, keyboard)
}

pub fn build_lot_description(lot: &LotDto) -> (String, InlineKeyboardMarkup) {
    let caption = format!(
        "📖 Описание лота '{}'\n\n\
        {}\n\n\
        Текущая ставка: {}",
        lot.title,
        lot.description,
        lot.current_bid
            .map(|b| format!("{} руб", b))
            .unwrap_or_else(|| "Нет ставок".to_string())
    );

    let mut keyboard = InlineKeyboardMarkup::default();

    if let Some(current_bid) = lot.current_bid {
        let new_bid = current_bid + lot.min_bid_step;
        keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
            format!(
                "💰 Повысить на {} руб (новая ставка: {} руб)",
                lot.min_bid_step, new_bid
            ),
            format!("bid_increase:{}", lot.id),
        )]);
        keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
            format!("✏️ Индивидуальная ставка (>{})", lot.min_bid_step),
            format!("set_bid:{}", lot.id),
        )]);
    } else {
        keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
            format!("🎯 Начать торги за {} руб", lot.starting_price),
            format!("bid_start:{}", lot.id),
        )]);
    }

    keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
        "◀️ Назад к лоту",
        format!("view_lot:{}", lot.id),
    )]);

    (caption, keyboard)
}

pub fn build_user_bids_view(bids: &[UserBidSummary]) -> (String, InlineKeyboardMarkup) {
    if bids.is_empty() {
        return (
            "У вас пока нет ставок.".to_string(),
            InlineKeyboardMarkup::default().append_row(vec![common::back_to_menu_button()]),
        );
    }

    let mut text = "📊 Ваши ставки:\n\n".to_string();
    for bid in bids {
        let status = if bid.is_winning {
            "🏆 Вы лидируете!"
        } else {
            "❌ Перебито"
        };
        text.push_str(&format!(
            "Лот {}: '{}'\n├ Ваша ставка: {} руб\n├ Текущая: {} руб\n└ {}\n\n",
            bid.lot_id, bid.lot_title, bid.user_max_bid, bid.current_bid, status
        ));
    }

    let keyboard = InlineKeyboardMarkup::default().append_row(vec![common::back_to_menu_button()]);

    (text, keyboard)
}
