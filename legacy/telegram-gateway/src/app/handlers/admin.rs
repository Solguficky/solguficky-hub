use crate::app::{
    actions::BotAction,
    fsm,
    state::{LotCreationStep, LotDraft, State},
    ui, Dependencies,
};
use teloxide::prelude::*;
use tracing::{debug, info, instrument};

use super::MyDialogue;

#[instrument(skip(q, dialogue), fields(user_id = %q.from.id, callback_id = %q.id, chat_id = ?q.message.as_ref().map(|m| m.chat().id)))]
pub async fn start_lot_creation_handler(
    q: CallbackQuery,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    info!("Admin started lot creation flow");

    let new_state = State::CreatingLot {
        step: LotCreationStep::EnteringTitle,
        draft: LotDraft::default(),
    };
    dialogue.update(new_state).await?;

    debug!("FSM state updated to EnteringTitle");

    let (text, keyboard) = ui::admin::build_enter_title_screen();

    let chat_id = q
        .message
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No message in callback"))?
        .chat()
        .id;

    info!("Lot creation flow initialized successfully");

    Ok(BotAction::Multiple(vec![
        BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        },
        BotAction::SendMessage {
            chat_id,
            text,
            keyboard: Some(keyboard),
        },
    ]))
}

#[instrument(skip(msg, dialogue), fields(chat_id = %msg.chat.id, user_id = ?msg.from.as_ref().map(|u| u.id), title_length = msg.text().map(|t| t.len()).unwrap_or(0)))]
pub async fn receive_lot_title_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let title = msg.text().unwrap_or_default().to_string();

    debug!("Received lot title input, validating...");

    match fsm::lot_creation::handle_title_input(msg.chat.id, current_state, title) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            info!("Lot title accepted, FSM transitioned to next step");
            Ok(transition.action)
        }
        Err(error_msg) => {
            info!(error = %error_msg, "Lot title validation failed");
            Ok(BotAction::SendMessage {
                chat_id: msg.chat.id,
                text: format!("❌ {}", error_msg),
                keyboard: None,
            })
        }
    }
}

#[instrument(skip(msg, dialogue), fields(chat_id = %msg.chat.id, user_id = ?msg.from.as_ref().map(|u| u.id), description_length = msg.text().map(|t| t.len()).unwrap_or(0)))]
pub async fn receive_lot_description_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let description = msg.text().unwrap_or_default().to_string();

    debug!("Received lot description input, validating...");

    match fsm::lot_creation::handle_description_input(msg.chat.id, current_state, description) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            info!("Lot description accepted, FSM transitioned to next step");
            Ok(transition.action)
        }
        Err(error_msg) => {
            info!(error = %error_msg, "Lot description validation failed");
            Ok(BotAction::SendMessage {
                chat_id: msg.chat.id,
                text: format!("❌ {}", error_msg),
                keyboard: None,
            })
        }
    }
}

#[instrument(skip(msg, dialogue), fields(chat_id = %msg.chat.id, user_id = ?msg.from.as_ref().map(|u| u.id), price_input = msg.text().unwrap_or_default()))]
pub async fn receive_lot_starting_price_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let price_str = msg.text().unwrap_or_default().to_string();

    debug!("Received lot starting price input, parsing and validating...");

    match fsm::lot_creation::handle_price_input(msg.chat.id, current_state, price_str) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            info!("Lot starting price accepted, FSM transitioned to next step");
            Ok(transition.action)
        }
        Err(error_msg) => {
            info!(error = %error_msg, "Lot starting price validation failed");
            Ok(BotAction::SendMessage {
                chat_id: msg.chat.id,
                text: format!("❌ {}", error_msg),
                keyboard: None,
            })
        }
    }
}

#[instrument(skip(msg, dialogue), fields(chat_id = %msg.chat.id, user_id = ?msg.from.as_ref().map(|u| u.id), step_input = msg.text().unwrap_or_default()))]
pub async fn receive_lot_min_bid_step_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let step_str = msg.text().unwrap_or_default().to_string();

    debug!("Received lot min bid step input, parsing and validating...");

    match fsm::lot_creation::handle_min_step_input(msg.chat.id, current_state, step_str) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            info!("Lot min bid step accepted, FSM transitioned to next step");
            Ok(transition.action)
        }
        Err(error_msg) => {
            info!(error = %error_msg, "Lot min bid step validation failed");
            Ok(BotAction::SendMessage {
                chat_id: msg.chat.id,
                text: format!("❌ {}", error_msg),
                keyboard: None,
            })
        }
    }
}

#[instrument(skip(msg, dialogue), fields(chat_id = %msg.chat.id, user_id = ?msg.from.as_ref().map(|u| u.id), url_length = msg.text().map(|t| t.len()).unwrap_or(0)))]
pub async fn receive_lot_image_url_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let url = msg.text().unwrap_or_default().to_string();

    debug!("Received lot image URL input, validating...");

    match fsm::lot_creation::handle_image_url_input(msg.chat.id, current_state, url) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            info!("Lot image URL accepted, FSM transitioned to confirmation step");
            Ok(transition.action)
        }
        Err(error_msg) => {
            info!(error = %error_msg, "Lot image URL validation failed");
            Ok(BotAction::SendMessage {
                chat_id: msg.chat.id,
                text: format!("❌ {}", error_msg),
                keyboard: None,
            })
        }
    }
}

#[instrument(skip(q, dialogue), fields(user_id = %q.from.id, callback_id = %q.id, chat_id = ?q.message.as_ref().map(|m| m.chat().id)))]
pub async fn skip_image_handler(
    q: CallbackQuery,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    info!("Admin skipped image upload");

    let current_state = dialogue.get().await?.unwrap_or_default();
    let chat_id = q
        .message
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No message in callback"))?
        .chat()
        .id;

    match fsm::lot_creation::handle_skip_image(chat_id, current_state) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            info!("Image skipped, FSM transitioned to confirmation step");
            Ok(BotAction::Multiple(vec![
                BotAction::AnswerCallback {
                    callback_id: q.id.to_string(),
                    text: None,
                },
                transition.action,
            ]))
        }
        Err(error_msg) => {
            info!(error = %error_msg, "Failed to skip image");
            Ok(BotAction::Multiple(vec![BotAction::AnswerCallback {
                callback_id: q.id.to_string(),
                text: Some(error_msg),
            }]))
        }
    }
}

#[instrument(skip(q, dialogue, deps), fields(user_id = %q.from.id, callback_id = %q.id, chat_id = ?q.message.as_ref().map(|m| m.chat().id)))]
pub async fn confirm_lot_creation_handler(
    q: CallbackQuery,
    dialogue: MyDialogue,
    deps: Dependencies,
) -> anyhow::Result<BotAction> {
    info!("Admin confirming lot creation");

    let current_state = dialogue.get().await?.unwrap_or_default();
    let chat_id = q
        .message
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No message in callback"))?
        .chat()
        .id;

    match fsm::lot_creation::handle_confirmation_with_service(
        chat_id,
        current_state,
        &deps.auction_service,
    )
    .await
    {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            info!("Lot created successfully, FSM reset to Idle");
            Ok(BotAction::Multiple(vec![
                BotAction::AnswerCallback {
                    callback_id: q.id.to_string(),
                    text: None,
                },
                transition.action,
            ]))
        }
        Err(error_msg) => {
            info!(error = %error_msg, "Lot creation failed");
            Ok(BotAction::Multiple(vec![
                BotAction::AnswerCallback {
                    callback_id: q.id.to_string(),
                    text: None,
                },
                BotAction::SendMessage {
                    chat_id,
                    text: format!("❌ {}", error_msg),
                    keyboard: None,
                },
            ]))
        }
    }
}

#[instrument(skip(q, dialogue), fields(user_id = %q.from.id, callback_id = %q.id, chat_id = ?q.message.as_ref().map(|m| m.chat().id)))]
pub async fn cancel_lot_creation_handler(
    q: CallbackQuery,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    info!("Admin cancelled lot creation");

    let current_state = dialogue.get().await?.unwrap_or_default();
    let chat_id = q
        .message
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No message in callback"))?
        .chat()
        .id;

    let transition = fsm::lot_creation::handle_cancel(chat_id, current_state);
    dialogue.update(transition.new_state).await?;

    info!("Lot creation cancelled, FSM reset to Idle");

    Ok(BotAction::Multiple(vec![
        BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        },
        transition.action,
    ]))
}
