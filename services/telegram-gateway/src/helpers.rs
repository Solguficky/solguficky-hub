use crate::app::actions::BotAction;
use teloxide::prelude::*;
use teloxide::types::{CallbackQueryId, InputFile};
use tracing::error;

/// Выполнение BotAction через Bot API
pub async fn execute_action(bot: &Bot, action: BotAction) -> anyhow::Result<()> {
    match action {
        BotAction::SendMessage {
            chat_id,
            text,
            keyboard,
        } => {
            let mut req = bot.send_message(chat_id, text);
            if let Some(kb) = keyboard {
                req = req.reply_markup(kb);
            }
            req.await?;
        }
        BotAction::EditMessage {
            chat_id,
            message_id,
            text,
            keyboard,
        } => {
            let mut req = bot.edit_message_text(chat_id, message_id, text);
            if let Some(kb) = keyboard {
                req = req.reply_markup(kb);
            }
            req.await?;
        }
        BotAction::AnswerCallback { callback_id, text } => {
            let cq_id = CallbackQueryId(callback_id);
            let mut req = bot.answer_callback_query(cq_id);
            if let Some(t) = text {
                req = req.text(t);
            }
            req.await?;
        }
        BotAction::SendPhoto {
            chat_id,
            photo_url,
            caption,
            keyboard,
        } => {
            let mut req = bot.send_photo(chat_id, InputFile::url(photo_url.parse()?));
            req = req.caption(&caption);
            if let Some(ref kb) = keyboard {
                req = req.reply_markup(kb.clone());
            }
            match req.await {
                Ok(_) => {}
                Err(e) => {
                    error!("Failed to send photo: {}", e);
                    // Fallback to text message
                    let mut fallback = bot.send_message(chat_id, caption);
                    if let Some(kb) = keyboard {
                        fallback = fallback.reply_markup(kb);
                    }
                    fallback.await?;
                }
            }
        }
        BotAction::Multiple(actions) => {
            for action in actions {
                Box::pin(execute_action(bot, action)).await?;
            }
        }
    }
    Ok(())
}

/// Helper для создания wrapper'ов хендлеров
/// Принимает замыкание, которое вызывает хендлер и возвращает Result<BotAction>
pub async fn handle_with_action<F, Fut>(bot: Bot, handler: F) -> anyhow::Result<()>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<BotAction>>,
{
    match handler().await {
        Ok(action) => {
            if let Err(e) = execute_action(&bot, action).await {
                error!("Failed to execute action: {}", e);
            }
        }
        Err(e) => {
            error!("Handler error: {}", e);
        }
    }
    Ok(())
}
