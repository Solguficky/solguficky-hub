use crate::app::{
    actions::BotAction,
    fsm,
    state::{LotCreationStep, LotDraft, State},
    ui, Dependencies,
};
use teloxide::prelude::*;

use super::MyDialogue;

pub async fn start_lot_creation_handler(
    q: CallbackQuery,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let new_state = State::CreatingLot {
        step: LotCreationStep::EnteringTitle,
        draft: LotDraft::default(),
    };
    dialogue.update(new_state).await?;

    let (text, keyboard) = ui::admin::build_enter_title_screen();

    let chat_id = q
        .message
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No message in callback"))?
        .chat()
        .id;

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

pub async fn receive_lot_title_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let title = msg.text().unwrap_or_default().to_string();

    match fsm::lot_creation::handle_title_input(msg.chat.id, current_state, title) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            Ok(transition.action)
        }
        Err(error_msg) => Ok(BotAction::SendMessage {
            chat_id: msg.chat.id,
            text: format!("❌ {}", error_msg),
            keyboard: None,
        }),
    }
}

pub async fn receive_lot_description_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let description = msg.text().unwrap_or_default().to_string();

    match fsm::lot_creation::handle_description_input(msg.chat.id, current_state, description) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            Ok(transition.action)
        }
        Err(error_msg) => Ok(BotAction::SendMessage {
            chat_id: msg.chat.id,
            text: format!("❌ {}", error_msg),
            keyboard: None,
        }),
    }
}

pub async fn receive_lot_starting_price_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let price_str = msg.text().unwrap_or_default().to_string();

    match fsm::lot_creation::handle_price_input(msg.chat.id, current_state, price_str) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            Ok(transition.action)
        }
        Err(error_msg) => Ok(BotAction::SendMessage {
            chat_id: msg.chat.id,
            text: format!("❌ {}", error_msg),
            keyboard: None,
        }),
    }
}

pub async fn receive_lot_min_bid_step_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let step_str = msg.text().unwrap_or_default().to_string();

    match fsm::lot_creation::handle_min_step_input(msg.chat.id, current_state, step_str) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            Ok(transition.action)
        }
        Err(error_msg) => Ok(BotAction::SendMessage {
            chat_id: msg.chat.id,
            text: format!("❌ {}", error_msg),
            keyboard: None,
        }),
    }
}

pub async fn receive_lot_image_url_handler(
    msg: Message,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let url = msg.text().unwrap_or_default().to_string();

    match fsm::lot_creation::handle_image_url_input(msg.chat.id, current_state, url) {
        Ok(transition) => {
            dialogue.update(transition.new_state).await?;
            Ok(transition.action)
        }
        Err(error_msg) => Ok(BotAction::SendMessage {
            chat_id: msg.chat.id,
            text: format!("❌ {}", error_msg),
            keyboard: None,
        }),
    }
}

pub async fn skip_image_handler(
    q: CallbackQuery,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
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
            Ok(BotAction::Multiple(vec![
                BotAction::AnswerCallback {
                    callback_id: q.id.to_string(),
                    text: None,
                },
                transition.action,
            ]))
        }
        Err(error_msg) => Ok(BotAction::Multiple(vec![BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: Some(error_msg),
        }])),
    }
}

pub async fn confirm_lot_creation_handler(
    q: CallbackQuery,
    dialogue: MyDialogue,
    deps: Dependencies,
) -> anyhow::Result<BotAction> {
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
            Ok(BotAction::Multiple(vec![
                BotAction::AnswerCallback {
                    callback_id: q.id.to_string(),
                    text: None,
                },
                transition.action,
            ]))
        }
        Err(error_msg) => Ok(BotAction::Multiple(vec![
            BotAction::AnswerCallback {
                callback_id: q.id.to_string(),
                text: None,
            },
            BotAction::SendMessage {
                chat_id,
                text: format!("❌ {}", error_msg),
                keyboard: None,
            },
        ])),
    }
}

pub async fn cancel_lot_creation_handler(
    q: CallbackQuery,
    dialogue: MyDialogue,
) -> anyhow::Result<BotAction> {
    let current_state = dialogue.get().await?.unwrap_or_default();
    let chat_id = q
        .message
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No message in callback"))?
        .chat()
        .id;

    let transition = fsm::lot_creation::handle_cancel(chat_id, current_state);
    dialogue.update(transition.new_state).await?;

    Ok(BotAction::Multiple(vec![
        BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        },
        transition.action,
    ]))
}
