use telegram_gateway::app::{
    fsm::lot_creation,
    state::{LotCreationStep, LotDraft, State},
};
use teloxide::types::ChatId;

#[test]
fn test_handle_title_input_success() {
    let chat_id = ChatId(123456);
    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringTitle,
        draft: LotDraft::default(),
    };
    let title = "Test Lot".to_string();

    let result = lot_creation::handle_title_input(chat_id, current_state, title.clone());

    assert!(result.is_ok());
    let transition = result.unwrap();

    // Проверяем, что состояние перешло к следующему шагу
    if let State::CreatingLot { step, draft } = transition.new_state {
        assert!(matches!(step, LotCreationStep::EnteringDescription));
        assert_eq!(draft.title, Some(title));
    } else {
        panic!("Expected CreatingLot state");
    }
}

#[test]
fn test_handle_title_input_empty() {
    let chat_id = ChatId(123456);
    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringTitle,
        draft: LotDraft::default(),
    };
    let title = "".to_string();

    let result = lot_creation::handle_title_input(chat_id, current_state, title);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), "Название не может быть пустым");
}

#[test]
fn test_handle_title_input_too_long() {
    let chat_id = ChatId(123456);
    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringTitle,
        draft: LotDraft::default(),
    };
    let title = "a".repeat(101); // 101 символ

    let result = lot_creation::handle_title_input(chat_id, current_state, title);

    assert!(result.is_err());
    assert_eq!(
        result.unwrap_err(),
        "Название слишком длинное (макс 100 символов)"
    );
}

#[test]
fn test_handle_description_input_success() {
    let chat_id = ChatId(123456);
    let mut draft = LotDraft::default();
    draft.title = Some("Test Lot".to_string());

    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringDescription,
        draft,
    };
    let description = "Test description".to_string();

    let result =
        lot_creation::handle_description_input(chat_id, current_state, description.clone());

    assert!(result.is_ok());
    let transition = result.unwrap();

    if let State::CreatingLot { step, draft } = transition.new_state {
        assert!(matches!(step, LotCreationStep::EnteringStartingPrice));
        assert_eq!(draft.description, Some(description));
    } else {
        panic!("Expected CreatingLot state");
    }
}

#[test]
fn test_handle_price_input_success() {
    let chat_id = ChatId(123456);
    let mut draft = LotDraft::default();
    draft.title = Some("Test Lot".to_string());
    draft.description = Some("Test description".to_string());

    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringStartingPrice,
        draft,
    };
    let price = "100.50".to_string();

    let result = lot_creation::handle_price_input(chat_id, current_state, price);

    assert!(result.is_ok());
    let transition = result.unwrap();

    if let State::CreatingLot { step, draft } = transition.new_state {
        assert!(matches!(step, LotCreationStep::EnteringMinBidStep));
        assert_eq!(draft.starting_price, Some(100.50));
    } else {
        panic!("Expected CreatingLot state");
    }
}

#[test]
fn test_handle_price_input_invalid() {
    let chat_id = ChatId(123456);
    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringStartingPrice,
        draft: LotDraft::default(),
    };
    let price = "not_a_number".to_string();

    let result = lot_creation::handle_price_input(chat_id, current_state, price);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), "Цена должна быть числом");
}

#[test]
fn test_handle_price_input_zero() {
    let chat_id = ChatId(123456);
    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringStartingPrice,
        draft: LotDraft::default(),
    };
    let price = "0".to_string();

    let result = lot_creation::handle_price_input(chat_id, current_state, price);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), "Цена должна быть больше 0");
}

#[test]
fn test_handle_min_step_input_success() {
    let chat_id = ChatId(123456);
    let mut draft = LotDraft::default();
    draft.title = Some("Test Lot".to_string());
    draft.description = Some("Test description".to_string());
    draft.starting_price = Some(100.0);

    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringMinBidStep,
        draft,
    };
    let min_step = "10.50".to_string();

    let result = lot_creation::handle_min_step_input(chat_id, current_state, min_step);

    assert!(result.is_ok());
    let transition = result.unwrap();

    if let State::CreatingLot { step, draft } = transition.new_state {
        assert!(matches!(step, LotCreationStep::EnteringImageUrl));
        assert_eq!(draft.min_bid_step, Some(10.50));
    } else {
        panic!("Expected CreatingLot state");
    }
}

#[test]
fn test_handle_image_url_input_with_url() {
    let chat_id = ChatId(123456);
    let mut draft = LotDraft::default();
    draft.title = Some("Test Lot".to_string());
    draft.description = Some("Test description".to_string());
    draft.starting_price = Some(100.0);
    draft.min_bid_step = Some(10.0);

    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringImageUrl,
        draft,
    };
    let url = "https://example.com/image.jpg".to_string();

    let result = lot_creation::handle_image_url_input(chat_id, current_state, url.clone());

    assert!(result.is_ok());
    let transition = result.unwrap();

    if let State::CreatingLot { step, draft } = transition.new_state {
        assert!(matches!(step, LotCreationStep::ConfirmingDraft));
        assert_eq!(draft.image_url, Some(url));
    } else {
        panic!("Expected CreatingLot state");
    }
}

#[test]
fn test_handle_image_url_input_skip() {
    let chat_id = ChatId(123456);
    let mut draft = LotDraft::default();
    draft.title = Some("Test Lot".to_string());
    draft.description = Some("Test description".to_string());
    draft.starting_price = Some(100.0);
    draft.min_bid_step = Some(10.0);

    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringImageUrl,
        draft,
    };
    let url = "skip".to_string();

    let result = lot_creation::handle_image_url_input(chat_id, current_state, url);

    assert!(result.is_ok());
    let transition = result.unwrap();

    if let State::CreatingLot { step, draft } = transition.new_state {
        assert!(matches!(step, LotCreationStep::ConfirmingDraft));
        assert_eq!(draft.image_url, Some("".to_string()));
    } else {
        panic!("Expected CreatingLot state");
    }
}

#[test]
fn test_handle_cancel() {
    let chat_id = ChatId(123456);
    let current_state = State::CreatingLot {
        step: LotCreationStep::EnteringTitle,
        draft: LotDraft::default(),
    };

    let transition = lot_creation::handle_cancel(chat_id, current_state);

    // Проверяем, что состояние сбросилось
    assert!(matches!(transition.new_state, State::Idle));
}

#[test]
fn test_full_fsm_flow() {
    let chat_id = ChatId(123456);

    // Шаг 1: Ввод названия
    let state1 = State::CreatingLot {
        step: LotCreationStep::EnteringTitle,
        draft: LotDraft::default(),
    };
    let trans1 = lot_creation::handle_title_input(chat_id, state1, "Test Lot".to_string()).unwrap();

    // Шаг 2: Ввод описания
    let trans2 = lot_creation::handle_description_input(
        chat_id,
        trans1.new_state,
        "Description".to_string(),
    )
    .unwrap();

    // Шаг 3: Ввод цены
    let trans3 =
        lot_creation::handle_price_input(chat_id, trans2.new_state, "100".to_string()).unwrap();

    // Шаг 4: Ввод мин. шага
    let trans4 =
        lot_creation::handle_min_step_input(chat_id, trans3.new_state, "10".to_string()).unwrap();

    // Шаг 5: Ввод URL (skip)
    let trans5 =
        lot_creation::handle_image_url_input(chat_id, trans4.new_state, "skip".to_string())
            .unwrap();

    // Проверяем финальное состояние
    if let State::CreatingLot { step, draft } = trans5.new_state {
        assert!(matches!(step, LotCreationStep::ConfirmingDraft));
        assert_eq!(draft.title, Some("Test Lot".to_string()));
        assert_eq!(draft.description, Some("Description".to_string()));
        assert_eq!(draft.starting_price, Some(100.0));
        assert_eq!(draft.min_bid_step, Some(10.0));
        assert_eq!(draft.image_url, Some("".to_string()));
    } else {
        panic!("Expected CreatingLot state with ConfirmingDraft");
    }
}
