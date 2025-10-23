use crate::app::{actions::BotAction, deps::Dependencies, ui, Command, UserRole};
use teloxide::prelude::*;
use tracing::{info, instrument};

#[instrument(skip(msg, _cmd, deps), fields(chat_id = %msg.chat.id, user_id = ?msg.from.as_ref().map(|u| u.id)))]
pub async fn start_handler(
    msg: Message,
    _cmd: Command,
    deps: Dependencies,
) -> anyhow::Result<BotAction> {
    let user_id = msg.from.as_ref().map(|u| u.id);

    let keyboard = if let Some(uid) = user_id {
        let role = deps.get_user_role(uid);
        match role {
            UserRole::Admin => ui::common::build_admin_main_menu(),
            UserRole::User => ui::common::build_main_menu(),
        }
    } else {
        ui::common::build_main_menu()
    };

    Ok(BotAction::SendMessage {
        chat_id: msg.chat.id,
        text: "Привет! 👋\n\n\
        Добро пожаловать на платформу Solguficky — место, где проходят аукционы для нашего комьюнити.\n\n\
        Используй кнопки ниже для навигации или нажми '❓ Как это работает?' если хочешь узнать больше!"
            .to_string(),
        keyboard: Some(keyboard),
    })
}

#[instrument(skip(q), fields(user_id = %q.from.id, callback_id = %q.id))]
pub async fn auction_info_handler(q: CallbackQuery) -> anyhow::Result<BotAction> {
    info!("User requested auction info");

    let (text, keyboard) = ui::common::build_auction_info();

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

pub async fn handle_unknown_message_handler(msg: Message) -> anyhow::Result<BotAction> {
    let (text, keyboard) = ui::common::build_unknown_message_prompt();

    Ok(BotAction::SendMessage {
        chat_id: msg.chat.id,
        text,
        keyboard: Some(keyboard),
    })
}
