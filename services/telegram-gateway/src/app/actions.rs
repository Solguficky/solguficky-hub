use teloxide::types::{ChatId, InlineKeyboardMarkup, MessageId};

#[derive(Debug)]
pub enum BotAction {
    SendMessage {
        chat_id: ChatId,
        text: String,
        keyboard: Option<InlineKeyboardMarkup>,
    },
    EditMessage {
        chat_id: ChatId,
        message_id: MessageId,
        text: String,
        keyboard: Option<InlineKeyboardMarkup>,
    },
    AnswerCallback {
        callback_id: String,
        text: Option<String>,
    },
    SendPhoto {
        chat_id: ChatId,
        photo_url: String,
        caption: String,
        keyboard: Option<InlineKeyboardMarkup>,
    },
    Multiple(Vec<BotAction>),
}

