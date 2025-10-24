use telegram_gateway::app::{
    state::LotDraft,
    ui::{admin, user},
};
use telegram_gateway::domain::{AuctionDto, AuctionStatus, LotDto};

#[test]
fn test_user_build_auction_list() {
    let auction = AuctionDto {
        event_id: "test-event".to_string(),
        event_name: "Test Event".to_string(),
        status: AuctionStatus::Running,
        lots: vec![
            LotDto {
                id: 1,
                title: "Lot 1".to_string(),
                description: "Description 1".to_string(),
                starting_price: 100.0,
                min_bid_step: 10.0,
                current_bid: None,
                current_bidder_id: None,
                image_url: "https://example.com/1.jpg".to_string(),
                bids: vec![],
            },
            LotDto {
                id: 2,
                title: "Lot 2".to_string(),
                description: "Description 2".to_string(),
                starting_price: 200.0,
                min_bid_step: 20.0,
                current_bid: Some(250.0),
                current_bidder_id: Some(12345),
                image_url: "https://example.com/2.jpg".to_string(),
                bids: vec![],
            },
        ],
    };

    let (text, keyboard) = user::build_auction_list(&auction);

    // Проверяем текст
    assert!(text.contains("Test Event"));
    assert!(text.contains("Running"));

    // Проверяем клавиатуру
    assert_eq!(keyboard.inline_keyboard.len(), 3); // 2 лота + кнопка "Главное меню"

    // Первая строка - первый лот
    assert_eq!(keyboard.inline_keyboard[0].len(), 1);
    assert!(keyboard.inline_keyboard[0][0].text.contains("Лот 1: Lot 1"));

    // Вторая строка - второй лот
    assert_eq!(keyboard.inline_keyboard[1].len(), 1);
    assert!(keyboard.inline_keyboard[1][0].text.contains("Лот 2: Lot 2"));

    // Третья строка - главное меню
    assert_eq!(keyboard.inline_keyboard[2].len(), 1);
    assert!(keyboard.inline_keyboard[2][0].text.contains("Главное меню"));
}

#[test]
fn test_user_build_lot_view_without_bids() {
    let lot = LotDto {
        id: 1,
        title: "Test Lot".to_string(),
        description: "Test Description".to_string(),
        starting_price: 100.0,
        min_bid_step: 10.0,
        current_bid: None,
        current_bidder_id: None,
        image_url: "https://example.com/image.jpg".to_string(),
        bids: vec![],
    };

    let (text, keyboard) = user::build_lot_view(&lot);

    // Проверяем текст
    assert!(text.contains("Test Lot"));
    assert!(text.contains("Нет ставок"));

    // Проверяем клавиатуру
    assert!(keyboard.inline_keyboard.len() >= 2);

    // Должна быть кнопка "Начать торги"
    let start_bid_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Начать торги"));
    assert!(start_bid_button.is_some());

    // Должна быть кнопка "Назад к лотам"
    let back_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Назад к лотам"));
    assert!(back_button.is_some());
}

#[test]
fn test_user_build_lot_view_with_bids() {
    let lot = LotDto {
        id: 1,
        title: "Test Lot".to_string(),
        description: "Test Description".to_string(),
        starting_price: 100.0,
        min_bid_step: 10.0,
        current_bid: Some(150.0),
        current_bidder_id: Some(12345),
        image_url: "https://example.com/image.jpg".to_string(),
        bids: vec![],
    };

    let (text, keyboard) = user::build_lot_view(&lot);

    // Проверяем текст
    assert!(text.contains("Test Lot"));
    assert!(text.contains("150 руб"));

    // Должна быть кнопка "Повысить"
    let increase_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Повысить"));
    assert!(increase_button.is_some());

    // Должна быть кнопка "Индивидуальная ставка"
    let custom_bid_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Индивидуальная ставка"));
    assert!(custom_bid_button.is_some());
}

#[test]
fn test_admin_build_admin_auction_view() {
    let auction = AuctionDto {
        event_id: "test-event".to_string(),
        event_name: "Test Event".to_string(),
        status: AuctionStatus::Running,
        lots: vec![LotDto {
            id: 1,
            title: "Lot 1".to_string(),
            description: "Description 1".to_string(),
            starting_price: 100.0,
            min_bid_step: 10.0,
            current_bid: None,
            current_bidder_id: None,
            image_url: "https://example.com/1.jpg".to_string(),
            bids: vec![],
        }],
    };

    let (text, keyboard) = admin::build_admin_auction_view(&auction);

    // Проверяем текст (должен быть как у обычного пользователя)
    assert!(text.contains("Test Event"));

    // Проверяем, что есть админская кнопка "Добавить лот"
    let add_lot_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Добавить лот"));
    assert!(add_lot_button.is_some());
}

#[test]
fn test_admin_build_enter_title_screen() {
    let (text, keyboard) = admin::build_enter_title_screen();

    // Проверяем текст
    assert!(text.contains("Шаг 1/5"));
    assert!(text.contains("название лота"));

    // Проверяем кнопку отмены
    let cancel_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Отмена"));
    assert!(cancel_button.is_some());
}

#[test]
fn test_admin_build_enter_description_screen() {
    let mut draft = LotDraft::default();
    draft.title = Some("Test Title".to_string());

    let (text, keyboard) = admin::build_enter_description_screen(&draft);

    // Проверяем текст
    assert!(text.contains("Test Title"));
    assert!(text.contains("Шаг 2/5"));
    assert!(text.contains("описание лота"));

    // Проверяем кнопки
    assert!(keyboard.inline_keyboard.len() >= 1);

    // Должна быть кнопка "Изменить название"
    let edit_title_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Изменить название"));
    assert!(edit_title_button.is_some());
}

#[test]
fn test_admin_build_confirmation_screen() {
    let draft = LotDraft {
        title: Some("Test Lot".to_string()),
        description: Some("Test Description".to_string()),
        starting_price: Some(100.0),
        min_bid_step: Some(10.0),
        image_url: Some("https://example.com/image.jpg".to_string()),
    };

    let (text, keyboard) = admin::build_confirmation_screen(&draft);

    // Проверяем текст
    assert!(text.contains("Test Lot"));
    assert!(text.contains("Test Description"));
    assert!(text.contains("100"));
    assert!(text.contains("10"));
    assert!(text.contains("example.com"));

    // Проверяем кнопку "Создать лот"
    let confirm_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Создать лот"));
    assert!(confirm_button.is_some());

    // Проверяем наличие кнопки редактирования
    let edit_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Редактировать"));
    assert!(edit_button.is_some()); // Есть кнопка редактирования
}

#[test]
fn test_admin_build_cancel_message() {
    let (text, keyboard) = admin::build_cancel_message();

    assert!(text.contains("отменено"));

    // Должна быть кнопка возврата в главное меню
    let back_button = keyboard
        .inline_keyboard
        .iter()
        .flatten()
        .find(|btn| btn.text.contains("Главное меню"));
    assert!(back_button.is_some());
}
