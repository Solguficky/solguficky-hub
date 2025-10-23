use crate::app::Command;
use teloxide::{prelude::*, types::InlineKeyboardMarkup};
use tracing::instrument;

#[instrument(skip(bot, msg, _cmd), fields(chat_id = %msg.chat.id, user_id = ?msg.from.as_ref().map(|u| u.id)))]
pub async fn start_handler(bot: Bot, msg: Message, _cmd: Command) -> anyhow::Result<()> {
    let keyboard = InlineKeyboardMarkup::default().append_row(vec![
        teloxide::types::InlineKeyboardButton::callback("🎪 Ближайший аукцион", "show_auction"),
    ]);

    bot.send_message(
        msg.chat.id,
        "Привет! Добро пожаловать на платформу Solguficky.\n\n\
        Здесь проходят аукционы для нашего комьюнити.",
    )
    .reply_markup(keyboard)
    .await?;

    Ok(())
}
