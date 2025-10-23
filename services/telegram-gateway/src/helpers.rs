use crate::app::actions::BotAction;
use teloxide::prelude::*;
use teloxide::types::{CallbackQueryId, InputFile};
use tracing::{debug, error, info, warn};

pub async fn execute_action(bot: &Bot, action: BotAction) -> anyhow::Result<()> {
    match action {
        BotAction::SendMessage {
            chat_id,
            text,
            keyboard,
        } => {
            debug!(
                chat_id = %chat_id,
                text_length = text.len(),
                has_keyboard = keyboard.is_some(),
                "Executing SendMessage action"
            );
            let mut req = bot.send_message(chat_id, text);
            if let Some(kb) = keyboard {
                req = req.reply_markup(kb);
            }
            req.await?;
            debug!(chat_id = %chat_id, "SendMessage executed successfully");
        }
        BotAction::EditMessage {
            chat_id,
            message_id,
            text,
            keyboard,
        } => {
            debug!(
                chat_id = %chat_id,
                message_id = %message_id,
                text_length = text.len(),
                has_keyboard = keyboard.is_some(),
                "Executing EditMessage action"
            );
            let mut req = bot.edit_message_text(chat_id, message_id, text);
            if let Some(kb) = keyboard {
                req = req.reply_markup(kb);
            }
            req.await?;
            debug!(chat_id = %chat_id, message_id = %message_id, "EditMessage executed successfully");
        }
        BotAction::AnswerCallback { callback_id, text } => {
            debug!(
                callback_id = %callback_id,
                has_text = text.is_some(),
                "Executing AnswerCallback action"
            );
            let cq_id = CallbackQueryId(callback_id);
            let mut req = bot.answer_callback_query(cq_id);
            if let Some(t) = text {
                req = req.text(t);
            }
            req.await?;
            debug!("AnswerCallback executed successfully");
        }
        BotAction::SendPhoto {
            chat_id,
            photo_url,
            caption,
            keyboard,
        } => {
            debug!(
                chat_id = %chat_id,
                photo_url = %photo_url,
                caption_length = caption.len(),
                has_keyboard = keyboard.is_some(),
                "Executing SendPhoto action"
            );
            let mut req = bot.send_photo(chat_id, InputFile::url(photo_url.parse()?));
            req = req.caption(&caption);
            if let Some(ref kb) = keyboard {
                req = req.reply_markup(kb.clone());
            }
            match req.await {
                Ok(_) => {
                    debug!(chat_id = %chat_id, "SendPhoto executed successfully");
                }
                Err(e) => {
                    warn!(
                        chat_id = %chat_id,
                        error = %e,
                        "Failed to send photo, falling back to text message"
                    );
                    let mut fallback = bot.send_message(chat_id, caption);
                    if let Some(kb) = keyboard {
                        fallback = fallback.reply_markup(kb);
                    }
                    fallback.await?;
                    info!(chat_id = %chat_id, "Fallback text message sent successfully");
                }
            }
        }
        BotAction::Multiple(actions) => {
            let actions_count = actions.len();
            debug!(actions_count, "Executing Multiple actions");
            for (idx, action) in actions.into_iter().enumerate() {
                debug!(
                    action_index = idx,
                    total = actions_count,
                    "Executing action from batch"
                );
                Box::pin(execute_action(bot, action)).await?;
            }
            debug!(
                actions_count,
                "All actions from batch executed successfully"
            );
        }
    }
    Ok(())
}

pub async fn handle_with_action<F, Fut>(bot: Bot, handler: F) -> anyhow::Result<()>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<BotAction>>,
{
    match handler().await {
        Ok(action) => {
            debug!("Handler executed successfully, processing action");
            if let Err(e) = execute_action(&bot, action).await {
                error!(error = %e, "Failed to execute action");
            }
        }
        Err(e) => {
            error!(error = %e, "Handler returned error");
        }
    }
    Ok(())
}
