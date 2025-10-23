use crate::app::{actions::BotAction, deps::Dependencies, state::State, ui};
use crate::domain::PlaceBidCommand;
use teloxide::prelude::*;
use tracing::{info, instrument};

use super::MyDialogue;

#[instrument(skip(q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn show_auction_handler(
    q: CallbackQuery,
    deps: Dependencies,
) -> anyhow::Result<BotAction> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        });
    }

    let auction = deps
        .auction_service
        .get_auction("summer-meetup-2024")
        .await?;

    let user_role = deps.get_user_role(q.from.id);

    let (text, keyboard) = match user_role {
        crate::app::auth::UserRole::Admin => ui::admin::build_admin_auction_view(&auction),
        crate::app::auth::UserRole::User => ui::user::build_auction_list(&auction),
    };

    let message = q
        .message
        .ok_or_else(|| anyhow::anyhow!("No message in callback"))?;

    Ok(BotAction::Multiple(vec![
        BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        },
        BotAction::EditMessage {
            chat_id: message.chat().id,
            message_id: message.id(),
            text,
            keyboard: Some(keyboard),
        },
    ]))
}

#[instrument(skip(q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn view_lot_handler(q: CallbackQuery, deps: Dependencies) -> anyhow::Result<BotAction> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        });
    }

    let lot_id: u32 = q
        .data
        .as_ref()
        .and_then(|d| d.strip_prefix("view_lot:"))
        .and_then(|id| id.parse().ok())
        .unwrap_or(1);

    let lot = deps
        .auction_service
        .get_lot("summer-meetup-2024", lot_id)
        .await?;

    if let Some(lot) = lot {
        let (text, keyboard) = ui::user::build_lot_view(&lot);
        let message = q
            .message
            .ok_or_else(|| anyhow::anyhow!("No message in callback"))?;

        Ok(BotAction::Multiple(vec![
            BotAction::AnswerCallback {
                callback_id: q.id.to_string(),
                text: None,
            },
            BotAction::EditMessage {
                chat_id: message.chat().id,
                message_id: message.id(),
                text,
                keyboard: Some(keyboard),
            },
        ]))
    } else {
        Ok(BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: Some("Лот не найден".to_string()),
        })
    }
}

#[instrument(skip(q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn show_description_handler(
    q: CallbackQuery,
    deps: Dependencies,
) -> anyhow::Result<BotAction> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        });
    }

    let lot_id: u32 = q
        .data
        .as_ref()
        .and_then(|d| d.strip_prefix("show_description:"))
        .and_then(|id| id.parse().ok())
        .unwrap_or(1);

    let lot = deps
        .auction_service
        .get_lot("summer-meetup-2024", lot_id)
        .await?;

    if let Some(lot) = lot {
        let (caption, keyboard) = ui::user::build_lot_description(&lot);
        let message = q
            .message
            .ok_or_else(|| anyhow::anyhow!("No message in callback"))?;
        let chat_id = message.chat().id;

        Ok(BotAction::Multiple(vec![
            BotAction::AnswerCallback {
                callback_id: q.id.to_string(),
                text: None,
            },
            BotAction::SendMessage {
                chat_id,
                text: caption,
                keyboard: Some(keyboard),
            },
        ]))
    } else {
        Ok(BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: Some("Лот не найден".to_string()),
        })
    }
}

#[instrument(skip(q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn bid_start_handler(q: CallbackQuery, deps: Dependencies) -> anyhow::Result<BotAction> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        });
    }

    let lot_id: u32 = q
        .data
        .as_ref()
        .and_then(|d| d.strip_prefix("bid_start:"))
        .and_then(|id| id.parse().ok())
        .unwrap_or(1);

    let lot = deps
        .auction_service
        .get_lot("summer-meetup-2024", lot_id)
        .await?;

    if let Some(lot) = lot {
        let user = q.from.id.0 as i64;
        let command = PlaceBidCommand::new(
            "summer-meetup-2024".to_string(),
            lot.id,
            user,
            lot.starting_price,
        );

        deps.nats.publish_place_bid(command).await?;

        info!(
            "Published PlaceBid command: lot_id={}, user_id={}, amount={}",
            lot.id, user, lot.starting_price
        );

        let message = q
            .message
            .ok_or_else(|| anyhow::anyhow!("No message in callback"))?;

        Ok(BotAction::Multiple(vec![
            BotAction::AnswerCallback {
                callback_id: q.id.to_string(),
                text: None,
            },
            BotAction::EditMessage {
                chat_id: message.chat().id,
                message_id: message.id(),
                text: format!(
                    "✅ Торги начались для '{}'.\n\
                    Ваша ставка: {} руб.\n\n\
                    Команда отправлена в систему!",
                    lot.title, lot.starting_price
                ),
                keyboard: None,
            },
        ]))
    } else {
        Ok(BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: Some("Лот не найден".to_string()),
        })
    }
}

#[instrument(skip(q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn bid_increase_handler(
    q: CallbackQuery,
    deps: Dependencies,
) -> anyhow::Result<BotAction> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        });
    }

    let lot_id: u32 = q
        .data
        .as_ref()
        .and_then(|d| d.strip_prefix("bid_increase:"))
        .and_then(|id| id.parse().ok())
        .unwrap_or(1);

    let lot = deps
        .auction_service
        .get_lot("summer-meetup-2024", lot_id)
        .await?;

    if let (Some(lot), Some(current_bid)) = (lot.as_ref(), lot.as_ref().and_then(|l| l.current_bid))
    {
        let user = q.from.id.0 as i64;
        let new_bid = current_bid + lot.min_bid_step;

        let command = PlaceBidCommand::new("summer-meetup-2024".to_string(), lot.id, user, new_bid);

        deps.nats.publish_place_bid(command).await?;

        info!(
            "Published PlaceBid command: lot_id={}, user_id={}, amount={}",
            lot.id, user, new_bid
        );

        let message = q
            .message
            .ok_or_else(|| anyhow::anyhow!("No message in callback"))?;

        Ok(BotAction::Multiple(vec![
            BotAction::AnswerCallback {
                callback_id: q.id.to_string(),
                text: None,
            },
            BotAction::EditMessage {
                chat_id: message.chat().id,
                message_id: message.id(),
                text: format!(
                    "✅ Ставка в {} руб была сделана для '{}'.\n\n\
                    Команда отправлена в систему!",
                    new_bid, lot.title
                ),
                keyboard: None,
            },
        ]))
    } else {
        Ok(BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: Some("Лот не найден или нет текущей ставки".to_string()),
        })
    }
}

#[instrument(skip(q, dialogue), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn set_bid_handler(q: CallbackQuery, dialogue: MyDialogue) -> anyhow::Result<BotAction> {
    let lot_id: u32 = q
        .data
        .as_ref()
        .and_then(|d| d.strip_prefix("set_bid:"))
        .and_then(|id| id.parse().ok())
        .unwrap_or(1);

    dialogue
        .update(State::WaitingForBidAmount { lot_id })
        .await?;

    let message = q
        .message
        .ok_or_else(|| anyhow::anyhow!("No message in callback"))?;

    Ok(BotAction::Multiple(vec![
        BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        },
        BotAction::EditMessage {
            chat_id: message.chat().id,
            message_id: message.id(),
            text: format!(
                "✏️ Введите вашу индивидуальную ставку для лота {}.\n\n\
                Ваша ставка должна быть числом (например: 500 или 1250.50)",
                lot_id
            ),
            keyboard: None,
        },
    ]))
}

#[instrument(skip(msg, dialogue, deps, state), fields(chat_id = %msg.chat.id, user_id = ?msg.from.as_ref().map(|u| u.id), state = ?state))]
pub async fn receive_bid_amount(
    msg: Message,
    dialogue: MyDialogue,
    deps: Dependencies,
    state: State,
) -> anyhow::Result<BotAction> {
    if let State::WaitingForBidAmount { lot_id } = state {
        match msg.text().and_then(|t| t.parse::<f64>().ok()) {
            Some(amount) if amount > 0.0 => {
                let user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);

                let command =
                    PlaceBidCommand::new("summer-meetup-2024".to_string(), lot_id, user_id, amount);

                deps.nats.publish_place_bid(command).await?;

                info!(
                    "Published PlaceBid command: lot_id={}, user_id={}, amount={}",
                    lot_id, user_id, amount
                );

                dialogue.update(State::Idle).await?;

                Ok(BotAction::SendMessage {
                    chat_id: msg.chat.id,
                    text: format!(
                        "✅ Ставка в {} руб была сделана для лота {}.\n\n\
                        Команда отправлена в систему!",
                        amount, lot_id
                    ),
                    keyboard: None,
                })
            }
            _ => Ok(BotAction::SendMessage {
                chat_id: msg.chat.id,
                text: "❌ Пожалуйста, введите корректное число (например: 500 или 1250.50)"
                    .to_string(),
                keyboard: None,
            }),
        }
    } else {
        Ok(BotAction::SendMessage {
            chat_id: msg.chat.id,
            text: "❌ Неверное состояние".to_string(),
            keyboard: None,
        })
    }
}

#[instrument(skip(q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn back_to_start_handler(
    q: CallbackQuery,
    deps: Dependencies,
) -> anyhow::Result<BotAction> {
    let message = q
        .message
        .ok_or_else(|| anyhow::anyhow!("No message in callback"))?;

    let role = deps.get_user_role(q.from.id);
    let keyboard = match role {
        crate::app::auth::UserRole::Admin => ui::common::build_admin_main_menu(),
        crate::app::auth::UserRole::User => ui::common::build_main_menu(),
    };

    Ok(BotAction::Multiple(vec![
        BotAction::AnswerCallback {
            callback_id: q.id.to_string(),
            text: None,
        },
        BotAction::EditMessage {
            chat_id: message.chat().id,
            message_id: message.id(),
            text: "Привет! Добро пожаловать на платформу Solguficky.\n\n\
            Здесь проходят аукционы для нашего комьюнити."
                .to_string(),
            keyboard: Some(keyboard),
        },
    ]))
}
