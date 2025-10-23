use crate::app::{
    actions::BotAction,
    state::{LotCreationStep, State},
    ui,
};
use crate::infra::MockAuctionService;
use teloxide::types::ChatId;

#[derive(Debug)]
pub struct FsmTransition {
    pub new_state: State,
    pub action: BotAction,
}

pub fn handle_title_input(
    chat_id: ChatId,
    current_state: State,
    title: String,
) -> Result<FsmTransition, String> {
    if let State::CreatingLot {
        step: LotCreationStep::EnteringTitle,
        mut draft,
    } = current_state
    {
        if title.trim().is_empty() {
            return Err("Название не может быть пустым".to_string());
        }

        if title.len() > 100 {
            return Err("Название слишком длинное (макс 100 символов)".to_string());
        }

        draft.title = Some(title);

        let new_state = State::CreatingLot {
            step: LotCreationStep::EnteringDescription,
            draft: draft.clone(),
        };

        let (text, keyboard) = ui::admin::build_enter_description_screen(&draft);

        Ok(FsmTransition {
            new_state,
            action: BotAction::SendMessage {
                chat_id,
                text,
                keyboard: Some(keyboard),
            },
        })
    } else {
        Err("Неверное состояние FSM".to_string())
    }
}

pub fn handle_description_input(
    chat_id: ChatId,
    current_state: State,
    description: String,
) -> Result<FsmTransition, String> {
    if let State::CreatingLot {
        step: LotCreationStep::EnteringDescription,
        mut draft,
    } = current_state
    {
        if description.trim().is_empty() {
            return Err("Описание не может быть пустым".to_string());
        }

        draft.description = Some(description);

        let new_state = State::CreatingLot {
            step: LotCreationStep::EnteringStartingPrice,
            draft: draft.clone(),
        };

        let (text, keyboard) = ui::admin::build_enter_price_screen(&draft);

        Ok(FsmTransition {
            new_state,
            action: BotAction::SendMessage {
                chat_id,
                text,
                keyboard: Some(keyboard),
            },
        })
    } else {
        Err("Неверное состояние FSM".to_string())
    }
}

pub fn handle_price_input(
    chat_id: ChatId,
    current_state: State,
    price_str: String,
) -> Result<FsmTransition, String> {
    if let State::CreatingLot {
        step: LotCreationStep::EnteringStartingPrice,
        mut draft,
    } = current_state
    {
        let price: f64 = price_str
            .parse()
            .map_err(|_| "Цена должна быть числом".to_string())?;

        if price <= 0.0 {
            return Err("Цена должна быть больше 0".to_string());
        }

        draft.starting_price = Some(price);

        let new_state = State::CreatingLot {
            step: LotCreationStep::EnteringMinBidStep,
            draft: draft.clone(),
        };

        let (text, keyboard) = ui::admin::build_enter_min_step_screen(&draft);

        Ok(FsmTransition {
            new_state,
            action: BotAction::SendMessage {
                chat_id,
                text,
                keyboard: Some(keyboard),
            },
        })
    } else {
        Err("Неверное состояние FSM".to_string())
    }
}

pub fn handle_min_step_input(
    chat_id: ChatId,
    current_state: State,
    step_str: String,
) -> Result<FsmTransition, String> {
    if let State::CreatingLot {
        step: LotCreationStep::EnteringMinBidStep,
        mut draft,
    } = current_state
    {
        let min_step: f64 = step_str
            .parse()
            .map_err(|_| "Минимальный шаг должен быть числом".to_string())?;

        if min_step <= 0.0 {
            return Err("Минимальный шаг должен быть больше 0".to_string());
        }

        draft.min_bid_step = Some(min_step);

        let new_state = State::CreatingLot {
            step: LotCreationStep::EnteringImageUrl,
            draft: draft.clone(),
        };

        let (text, keyboard) = ui::admin::build_enter_image_url_screen(&draft);

        Ok(FsmTransition {
            new_state,
            action: BotAction::SendMessage {
                chat_id,
                text,
                keyboard: Some(keyboard),
            },
        })
    } else {
        Err("Неверное состояние FSM".to_string())
    }
}

pub fn handle_image_url_input(
    chat_id: ChatId,
    current_state: State,
    url: String,
) -> Result<FsmTransition, String> {
    if let State::CreatingLot {
        step: LotCreationStep::EnteringImageUrl,
        mut draft,
    } = current_state
    {
        if url.trim().to_lowercase() == "skip" {
            draft.image_url = Some("".to_string());
        } else {
            draft.image_url = Some(url);
        }

        let new_state = State::CreatingLot {
            step: LotCreationStep::ConfirmingDraft,
            draft: draft.clone(),
        };

        let (text, keyboard) = ui::admin::build_confirmation_screen(&draft);

        Ok(FsmTransition {
            new_state,
            action: BotAction::SendMessage {
                chat_id,
                text,
                keyboard: Some(keyboard),
            },
        })
    } else {
        Err("Неверное состояние FSM".to_string())
    }
}

pub fn handle_skip_image(chat_id: ChatId, current_state: State) -> Result<FsmTransition, String> {
    if let State::CreatingLot {
        step: LotCreationStep::EnteringImageUrl,
        mut draft,
    } = current_state
    {
        draft.image_url = Some("".to_string());

        let new_state = State::CreatingLot {
            step: LotCreationStep::ConfirmingDraft,
            draft: draft.clone(),
        };

        let (text, keyboard) = ui::admin::build_confirmation_screen(&draft);

        Ok(FsmTransition {
            new_state,
            action: BotAction::SendMessage {
                chat_id,
                text,
                keyboard: Some(keyboard),
            },
        })
    } else {
        Err("Неверное состояние FSM".to_string())
    }
}

pub async fn handle_confirmation_with_service(
    chat_id: ChatId,
    current_state: State,
    auction_service: &MockAuctionService,
) -> Result<FsmTransition, String> {
    if let State::CreatingLot {
        step: LotCreationStep::ConfirmingDraft,
        draft,
    } = current_state
    {
        let lot = draft.to_lot_dto();

        match auction_service.create_lot(lot).await {
            Ok(created_lot) => {
                let text = format!("✅ Лот #{} '{}' создан!", created_lot.id, created_lot.title);
                let keyboard = ui::common::build_back_to_menu_keyboard();

                Ok(FsmTransition {
                    new_state: State::Idle,
                    action: BotAction::SendMessage {
                        chat_id,
                        text,
                        keyboard: Some(keyboard),
                    },
                })
            }
            Err(e) => Err(format!("Ошибка создания лота: {}", e)),
        }
    } else {
        Err("Неверное состояние FSM".to_string())
    }
}

pub fn handle_cancel(chat_id: ChatId, _current_state: State) -> FsmTransition {
    let (text, keyboard) = ui::admin::build_cancel_message();

    FsmTransition {
        new_state: State::Idle,
        action: BotAction::SendMessage {
            chat_id,
            text,
            keyboard: Some(keyboard),
        },
    }
}
