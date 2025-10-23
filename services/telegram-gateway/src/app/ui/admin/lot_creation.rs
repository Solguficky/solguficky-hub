use crate::app::{state::LotDraft, ui::common};
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup};

pub fn build_enter_title_screen() -> (String, InlineKeyboardMarkup) {
    let text = "➕ Создание нового лота\n\n\
        Шаг 1/5: Введите название лота";

    let keyboard = InlineKeyboardMarkup::default().append_row(vec![common::cancel_button()]);

    (text.to_string(), keyboard)
}

pub fn build_enter_description_screen(draft: &LotDraft) -> (String, InlineKeyboardMarkup) {
    let text = format!(
        "➕ Создание нового лота\n\n\
        ✅ Название: {}\n\n\
        Шаг 2/5: Введите описание лота",
        draft.title.as_ref().unwrap_or(&"".to_string())
    );

    let keyboard = InlineKeyboardMarkup::default().append_row(vec![
        InlineKeyboardButton::callback("✏️ Изменить название", "admin:edit_title"),
        common::cancel_button(),
    ]);

    (text, keyboard)
}

pub fn build_enter_price_screen(draft: &LotDraft) -> (String, InlineKeyboardMarkup) {
    let text = format!(
        "➕ Создание нового лота\n\n\
        ✅ Название: {}\n\
        ✅ Описание: {}\n\n\
        Шаг 3/5: Введите стартовую цену (руб)",
        draft.title.as_ref().unwrap_or(&"".to_string()),
        draft
            .description
            .as_ref()
            .map(|d| {
                if d.len() > 50 {
                    format!("{}...", &d[..50])
                } else {
                    d.clone()
                }
            })
            .unwrap_or_default()
    );

    let keyboard = InlineKeyboardMarkup::default().append_row(vec![
        InlineKeyboardButton::callback("✏️ Изменить описание", "admin:edit_description"),
        common::cancel_button(),
    ]);

    (text, keyboard)
}

pub fn build_enter_min_step_screen(draft: &LotDraft) -> (String, InlineKeyboardMarkup) {
    let text = format!(
        "➕ Создание нового лота\n\n\
        ✅ Название: {}\n\
        ✅ Стартовая цена: {} руб\n\n\
        Шаг 4/5: Введите минимальный шаг ставки (руб)",
        draft.title.as_ref().unwrap_or(&"".to_string()),
        draft
            .starting_price
            .map(|p| format!("{:.2}", p))
            .unwrap_or_default()
    );

    let keyboard = InlineKeyboardMarkup::default().append_row(vec![
        InlineKeyboardButton::callback("✏️ Изменить цену", "admin:edit_price"),
        common::cancel_button(),
    ]);

    (text, keyboard)
}

pub fn build_enter_image_url_screen(draft: &LotDraft) -> (String, InlineKeyboardMarkup) {
    let text = format!(
        "➕ Создание нового лота\n\n\
        ✅ Название: {}\n\
        ✅ Стартовая цена: {} руб\n\
        ✅ Минимальный шаг: {} руб\n\n\
        Шаг 5/5: Введите URL изображения лота\n\
        (или отправьте 'skip' чтобы пропустить)",
        draft.title.as_ref().unwrap_or(&"".to_string()),
        draft
            .starting_price
            .map(|p| format!("{:.2}", p))
            .unwrap_or_default(),
        draft
            .min_bid_step
            .map(|s| format!("{:.2}", s))
            .unwrap_or_default()
    );

    let keyboard = InlineKeyboardMarkup::default()
        .append_row(vec![InlineKeyboardButton::callback(
            "⏭️ Пропустить",
            "admin:skip_image",
        )])
        .append_row(vec![
            InlineKeyboardButton::callback("✏️ Изменить шаг", "admin:edit_min_step"),
            common::cancel_button(),
        ]);

    (text, keyboard)
}

pub fn build_confirmation_screen(draft: &LotDraft) -> (String, InlineKeyboardMarkup) {
    let text = format!(
        "➕ Подтверждение создания лота\n\n\
        📦 Название: {}\n\
        📝 Описание: {}\n\
        💰 Стартовая цена: {} руб\n\
        📊 Минимальный шаг: {} руб\n\
        🖼️ Изображение: {}\n\n\
        Все верно?",
        draft.title.as_ref().unwrap_or(&"Не указано".to_string()),
        draft
            .description
            .as_ref()
            .unwrap_or(&"Не указано".to_string()),
        draft
            .starting_price
            .map(|p| format!("{:.2}", p))
            .unwrap_or_else(|| "0".to_string()),
        draft
            .min_bid_step
            .map(|s| format!("{:.2}", s))
            .unwrap_or_else(|| "0".to_string()),
        draft
            .image_url
            .as_ref()
            .unwrap_or(&"Не указано".to_string())
    );

    let keyboard = InlineKeyboardMarkup::default()
        .append_row(vec![InlineKeyboardButton::callback(
            "✅ Создать лот",
            "admin:confirm_lot",
        )])
        .append_row(vec![
            InlineKeyboardButton::callback("✏️ Редактировать", "admin:edit_menu"),
            common::cancel_button(),
        ]);

    (text, keyboard)
}

pub fn build_cancel_message() -> (String, InlineKeyboardMarkup) {
    let text = "❌ Создание лота отменено";
    let keyboard = common::build_back_to_menu_keyboard();
    (text.to_string(), keyboard)
}
