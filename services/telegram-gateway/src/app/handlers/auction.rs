use crate::app::{deps::Dependencies, state::State};
use crate::domain::PlaceBidCommand;
use teloxide::{
    dispatching::dialogue::InMemStorage,
    prelude::*,
    types::{InlineKeyboardButton, InlineKeyboardMarkup},
};
use tracing::{error, info, instrument};

pub type MyDialogue = Dialogue<State, InMemStorage<State>>;

#[instrument(skip(bot, q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn show_auction_handler(
    bot: Bot,
    q: CallbackQuery,
    deps: Dependencies,
) -> anyhow::Result<()> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(());
    }

    bot.answer_callback_query(q.id.clone()).await?;

    let auction = deps
        .auction_service
        .get_auction("summer-meetup-2024")
        .await?;

    let mut keyboard = InlineKeyboardMarkup::default();

    for lot in auction.lots.iter().take(5) {
        keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
            format!("Лот {}: {}", lot.id, lot.title),
            format!("view_lot:{}", lot.id),
        )]);
    }

    keyboard = keyboard.append_row(vec![InlineKeyboardButton::callback(
        "🏠 Главное меню",
        "back_to_start",
    )]);

    let text = format!(
        "🎪 Аукцион: {}\n\nСтатус: {:?}\n\nДоступные лоты:",
        auction.event_name, auction.status
    );

    if let Some(message) = q.message {
        let chat_id = message.chat().id;
        bot.edit_message_text(chat_id, message.id(), text)
            .reply_markup(keyboard)
            .await?;
    }

    Ok(())
}

#[instrument(skip(bot, q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn view_lot_handler(
    bot: Bot,
    q: CallbackQuery,
    deps: Dependencies,
) -> anyhow::Result<()> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(());
    }

    bot.answer_callback_query(q.id.clone()).await?;

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

        let text = format!(
            "📦 Лот: {}\n\n\
            Текущая ставка: {}\n\n\
            Выберите действие:",
            lot.title,
            lot.current_bid
                .map(|b| format!("{} руб", b))
                .unwrap_or_else(|| "Нет ставок".to_string())
        );

        if let Some(message) = q.message {
            let chat_id = message.chat().id;
            bot.edit_message_text(chat_id, message.id(), text)
                .reply_markup(keyboard)
                .await?;
        }
    }

    Ok(())
}

#[instrument(skip(bot, q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn show_description_handler(
    bot: Bot,
    q: CallbackQuery,
    deps: Dependencies,
) -> anyhow::Result<()> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(());
    }

    bot.answer_callback_query(q.id.clone()).await?;

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

        if let Some(message) = q.message {
            let chat_id = message.chat().id;
            if lot.image_url.starts_with("http") {
                let caption_text = caption.clone();
                match bot
                    .send_photo(
                        chat_id,
                        teloxide::types::InputFile::url(lot.image_url.parse()?),
                    )
                    .caption(caption)
                    .reply_markup(keyboard.clone())
                    .await
                {
                    Ok(_) => {}
                    Err(e) => {
                        error!("Failed to send photo: {}", e);
                        bot.send_message(chat_id, caption_text)
                            .reply_markup(keyboard)
                            .await?;
                    }
                }
            }
        }
    }

    Ok(())
}

#[instrument(skip(bot, q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn bid_start_handler(
    bot: Bot,
    q: CallbackQuery,
    deps: Dependencies,
) -> anyhow::Result<()> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(());
    }

    bot.answer_callback_query(q.id.clone()).await?;

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

        if let Some(message) = q.message {
            let chat_id = message.chat().id;
            bot.edit_message_text(
                chat_id,
                message.id(),
                format!(
                    "✅ Торги начались для '{}'.\n\
                    Ваша ставка: {} руб.\n\n\
                    Команда отправлена в систему!",
                    lot.title, lot.starting_price
                ),
            )
            .await?;
        }
    }

    Ok(())
}

#[instrument(skip(bot, q, deps), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn bid_increase_handler(
    bot: Bot,
    q: CallbackQuery,
    deps: Dependencies,
) -> anyhow::Result<()> {
    if !deps.idempotency.check_and_insert(q.id.to_string()) {
        info!("Duplicate callback_query detected, skipping");
        return Ok(());
    }

    bot.answer_callback_query(q.id.clone()).await?;

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

        if let Some(message) = q.message {
            let chat_id = message.chat().id;
            bot.edit_message_text(
                chat_id,
                message.id(),
                format!(
                    "✅ Ставка в {} руб была сделана для '{}'.\n\n\
                    Команда отправлена в систему!",
                    new_bid, lot.title
                ),
            )
            .await?;
        }
    }

    Ok(())
}

#[instrument(skip(bot, q, dialogue), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn set_bid_handler(
    bot: Bot,
    q: CallbackQuery,
    dialogue: MyDialogue,
) -> anyhow::Result<()> {
    bot.answer_callback_query(q.id.clone()).await?;

    let lot_id: u32 = q
        .data
        .as_ref()
        .and_then(|d| d.strip_prefix("set_bid:"))
        .and_then(|id| id.parse().ok())
        .unwrap_or(1);

    dialogue
        .update(State::WaitingForBidAmount { lot_id })
        .await?;

    if let Some(message) = q.message {
        let chat_id = message.chat().id;
        bot.edit_message_text(
            chat_id,
            message.id(),
            format!(
                "✏️ Введите вашу индивидуальную ставку для лота {}.\n\n\
                Ваша ставка должна быть числом (например: 500 или 1250.50)",
                lot_id
            ),
        )
        .await?;
    }

    Ok(())
}

#[instrument(skip(bot, msg, dialogue, deps, state), fields(chat_id = %msg.chat.id, user_id = ?msg.from.as_ref().map(|u| u.id), state = ?state))]
pub async fn receive_bid_amount(
    bot: Bot,
    msg: Message,
    dialogue: MyDialogue,
    deps: Dependencies,
    state: State,
) -> anyhow::Result<()> {
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

                bot.send_message(
                    msg.chat.id,
                    format!(
                        "✅ Ставка в {} руб была сделана для лота {}.\n\n\
                        Команда отправлена в систему!",
                        amount, lot_id
                    ),
                )
                .await?;

                dialogue.update(State::Idle).await?;
            }
            _ => {
                bot.send_message(
                    msg.chat.id,
                    "❌ Пожалуйста, введите корректное число (например: 500 или 1250.50)",
                )
                .await?;
            }
        }
    }

    Ok(())
}

#[instrument(skip(bot, q), fields(user_id = %q.from.id, callback_data = ?q.data, callback_id = %q.id))]
pub async fn back_to_start_handler(bot: Bot, q: CallbackQuery) -> anyhow::Result<()> {
    bot.answer_callback_query(q.id.clone()).await?;

    let keyboard =
        InlineKeyboardMarkup::default().append_row(vec![InlineKeyboardButton::callback(
            "🎪 Ближайший аукцион",
            "show_auction",
        )]);

    if let Some(message) = q.message {
        let chat_id = message.chat().id;
        bot.edit_message_text(
            chat_id,
            message.id(),
            "Привет! Добро пожаловать на платформу Solguficky.\n\n\
            Здесь проходят аукционы для нашего комьюнити.",
        )
        .reply_markup(keyboard)
        .await?;
    }

    Ok(())
}
