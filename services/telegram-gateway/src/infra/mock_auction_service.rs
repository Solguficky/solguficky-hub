use crate::domain::{AuctionDto, AuctionStatus, LotDto};
use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct MockAuctionService {
    dynamic_lots: Arc<RwLock<Vec<LotDto>>>,
}

impl Default for MockAuctionService {
    fn default() -> Self {
        Self::new()
    }
}

impl MockAuctionService {
    pub fn new() -> Self {
        Self {
            dynamic_lots: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub async fn get_auction(&self, _event_id: &str) -> Result<AuctionDto> {
        let hardcoded_lots = self.get_mock_lots();
        let dynamic_lots = self.dynamic_lots.read().await;

        let mut all_lots = hardcoded_lots;
        all_lots.extend(dynamic_lots.clone());

        Ok(AuctionDto {
            event_id: "summer-meetup-2024".to_string(),
            event_name: "Летняя Сходка 2024".to_string(),
            status: AuctionStatus::Running,
            lots: all_lots,
        })
    }

    pub async fn get_lot(&self, _event_id: &str, lot_id: u32) -> Result<Option<LotDto>> {
        let hardcoded_lots = self.get_mock_lots();
        if let Some(lot) = hardcoded_lots.into_iter().find(|l| l.id == lot_id) {
            return Ok(Some(lot));
        }

        let dynamic_lots = self.dynamic_lots.read().await;
        Ok(dynamic_lots.iter().find(|l| l.id == lot_id).cloned())
    }

    pub async fn create_lot(&self, mut lot: LotDto) -> Result<LotDto> {
        let mut lots = self.dynamic_lots.write().await;

        if lot.title.trim().is_empty() {
            return Err(anyhow::anyhow!("Название не может быть пустым"));
        }
        if lot.starting_price <= 0.0 {
            return Err(anyhow::anyhow!("Стартовая цена должна быть больше 0"));
        }
        if lot.min_bid_step <= 0.0 {
            return Err(anyhow::anyhow!("Минимальный шаг должен быть больше 0"));
        }

        let max_id = lots.iter().map(|l| l.id).max().unwrap_or(5);
        lot.id = max_id + 1;

        lots.push(lot.clone());
        Ok(lot)
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
