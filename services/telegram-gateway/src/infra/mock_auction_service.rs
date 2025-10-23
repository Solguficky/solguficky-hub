use crate::domain::{AuctionDto, AuctionStatus, LotDto};
use anyhow::Result;

pub struct MockAuctionService;

impl MockAuctionService {
    pub fn new() -> Self {
        Self
    }

    pub async fn get_auction(&self, _event_id: &str) -> Result<AuctionDto> {
        Ok(AuctionDto {
            event_id: "summer-meetup-2024".to_string(),
            event_name: "Летняя Сходка 2024".to_string(),
            status: AuctionStatus::Running,
            lots: self.get_mock_lots(),
        })
    }

    pub async fn get_lot(&self, _event_id: &str, lot_id: u32) -> Result<Option<LotDto>> {
        Ok(self.get_mock_lots().into_iter().find(|l| l.id == lot_id))
    }

    fn get_mock_lots(&self) -> Vec<LotDto> {
        vec![
            LotDto {
                id: 1,
                title: "Значок \"Собака\"".to_string(),
                description: "Существуют ли пчелы, или это всё гуфеня в костюме. Срисован с арта нашего любимого Пети. С двойным креплением.\nАвтор - Нян".to_string(),
                starting_price: 100.0,
                min_bid_step: 50.0,
                current_bid: None,
                current_bidder_id: None,
                image_url: "https://imgur.com/a/PHuRNJw".to_string(),
            },
            LotDto {
                id: 2,
                title: "Кашпо \"Cash_po\"".to_string(),
                description: "Мистер всратыш, который притворяется кашпо. К передаче владельцу будет обшкурен, очищен и покрашен\n\nМатериал — гипс\nДиаметр дырки ~7см\nВысота от внутренней ступеньки до верха ~5см\n\nСам кашпо:\nДиаметр 14,5 см\nМакс. высота 12 см\n\nПодойдёт для мелких цветочков, кактусов там, суккулентов.\nАвтор - Петя".to_string(),
                starting_price: 500.0,
                min_bid_step: 100.0,
                current_bid: None,
                current_bidder_id: None,
                image_url: "https://imgur.com/a/YB0awqD".to_string(),
            },
            LotDto {
                id: 3,
                title: "Футболка \"Шесть обличий Алекса Гуфовского\"".to_string(),
                description: "Стример, представленный в своих разных амплуа. Кто заметил пасхалку - молодец.\n\nДанный лот представляет собой возможность использовать экслюзивно отрисованный принт для футболки.\nС выигравшим лот мы согласуем размер и цвет футболки.\nАвтор - Nato".to_string(),
                starting_price: 1000.0,
                min_bid_step: 69.0,
                current_bid: None,
                current_bidder_id: None,
                image_url: "https://imgur.com/a/YS75ov9".to_string(),
            },
            LotDto {
                id: 4,
                title: "Значок \"Хрю\"".to_string(),
                description: "ХРЮКНИ. Нейросеть не может, а значок может. С двойным креплением.\nАвтор - Нян".to_string(),
                starting_price: 100.0,
                min_bid_step: 50.0,
                current_bid: None,
                current_bidder_id: None,
                image_url: "https://imgur.com/a/Mifg2Cr".to_string(),
            },
            LotDto {
                id: 5,
                title: "Значок \"Портал\"".to_string(),
                description: "ДЛЯ ТЕБЯ И ДЛЯ НЕЁ/НЕГО. Или только для тебя. Ну портал типа\nАвтор - Нян".to_string(),
                starting_price: 100.0,
                min_bid_step: 50.0,
                current_bid: None,
                current_bidder_id: None,
                image_url: "https://imgur.com/a/YKLNNEw".to_string(),
            },
        ]
    }
}
