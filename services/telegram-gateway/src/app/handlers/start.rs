use crate::app::{actions::BotAction, deps::Dependencies, ui, Command, UserRole};
use teloxide::prelude::*;
use tracing::instrument;

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
        text: "Привет! Добро пожаловать на платформу Solguficky.\n\n\
        Здесь проходят аукционы для нашего комьюнити."
            .to_string(),
        keyboard: Some(keyboard),
    })
}
