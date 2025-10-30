use crate::domain::{AuctionDto, AuctionStatus, BidInfo, LotDto};
use anyhow::Result;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use tracing::{debug, error, info};

#[derive(Debug, Clone)]
pub struct UserBidSummary {
    pub lot_id: u32,
    pub lot_title: String,
    pub user_max_bid: f64,
    pub current_bid: f64,
    pub is_winning: bool,
}

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

    pub async fn get_auction(&self, auction_id: &str) -> Result<AuctionDto> {
        debug!(auction_id, "Fetching auction data");

        let hardcoded_lots = self.get_mock_lots();
        let dynamic_lots = self.dynamic_lots.read().await;

        let mut all_lots = hardcoded_lots;
        all_lots.extend(dynamic_lots.clone());

        debug!(
            auction_id,
            total_lots = all_lots.len(),
            hardcoded_lots = self.get_mock_lots().len(),
            dynamic_lots = dynamic_lots.len(),
            "Auction data retrieved"
        );

        Ok(AuctionDto {
            auction_id: crate::constants::AUCTION_ID.to_string(),
            auction_name: "Летняя Сходка 2024".to_string(),
            status: AuctionStatus::Running,
            lots: all_lots,
        })
    }

    pub async fn get_lot(&self, auction_id: &str, lot_id: u32) -> Result<Option<LotDto>> {
        debug!(auction_id, lot_id, "Fetching lot data");

        let hardcoded_lots = self.get_mock_lots();
        if let Some(lot) = hardcoded_lots.into_iter().find(|l| l.id == lot_id) {
            debug!(
                auction_id,
                lot_id,
                title = %lot.title,
                "Lot found in hardcoded data"
            );
            return Ok(Some(lot));
        }

        let dynamic_lots = self.dynamic_lots.read().await;
        let result = dynamic_lots.iter().find(|l| l.id == lot_id).cloned();

        if result.is_some() {
            debug!(auction_id, lot_id, "Lot found in dynamic data");
        } else {
            debug!(auction_id, lot_id, "Lot not found");
        }

        Ok(result)
    }

    pub async fn create_lot(&self, mut lot: LotDto) -> Result<LotDto> {
        debug!(
            title = %lot.title,
            starting_price = lot.starting_price,
            min_bid_step = lot.min_bid_step,
            "Creating new lot"
        );

        let mut lots = self.dynamic_lots.write().await;

        if lot.title.trim().is_empty() {
            error!("Lot creation failed: empty title");
            return Err(anyhow::anyhow!("Название не может быть пустым"));
        }
        if lot.starting_price <= 0.0 {
            error!(
                starting_price = lot.starting_price,
                "Lot creation failed: invalid starting price"
            );
            return Err(anyhow::anyhow!("Стартовая цена должна быть больше 0"));
        }
        if lot.min_bid_step <= 0.0 {
            error!(
                min_bid_step = lot.min_bid_step,
                "Lot creation failed: invalid min bid step"
            );
            return Err(anyhow::anyhow!("Минимальный шаг должен быть больше 0"));
        }

        let max_id = lots.iter().map(|l| l.id).max().unwrap_or(5);
        lot.id = max_id + 1;
        lot.bids = vec![];

        info!(
            lot_id = lot.id,
            title = %lot.title,
            starting_price = lot.starting_price,
            min_bid_step = lot.min_bid_step,
            has_image = !lot.image_url.is_empty(),
            "Lot created successfully"
        );

        lots.push(lot.clone());
        Ok(lot)
    }

    pub async fn record_bid(&self, lot_id: u32, user_id: i64, amount: f64) -> Result<()> {
        debug!(lot_id, user_id, amount, "Recording bid");

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let bid_info = BidInfo {
            user_id,
            amount,
            timestamp,
        };

        let mut dynamic_lots = self.dynamic_lots.write().await;

        if let Some(lot) = dynamic_lots.iter_mut().find(|l| l.id == lot_id) {
            lot.bids.push(bid_info);
            lot.current_bid = Some(amount);
            lot.current_bidder_id = Some(user_id);

            info!(
                lot_id,
                user_id,
                amount,
                total_bids = lot.bids.len(),
                "Bid recorded successfully in dynamic lot"
            );

            return Ok(());
        }

        drop(dynamic_lots);

        info!(
            lot_id,
            user_id, amount, "Bid recorded for hardcoded lot (in-memory only)"
        );

        Ok(())
    }

    pub async fn get_user_bids(&self, user_id: i64) -> Result<Vec<UserBidSummary>> {
        debug!(user_id, "Fetching user bids");

        let mut summaries = Vec::new();
        let hardcoded_lots = self.get_mock_lots();
        let dynamic_lots = self.dynamic_lots.read().await;

        let all_lots: Vec<&LotDto> = hardcoded_lots.iter().chain(dynamic_lots.iter()).collect();

        for lot in all_lots {
            let user_bids: Vec<&BidInfo> =
                lot.bids.iter().filter(|b| b.user_id == user_id).collect();

            if let Some(max_bid) = user_bids
                .iter()
                .map(|b| b.amount)
                .max_by(|a, b| a.partial_cmp(b).unwrap())
            {
                let current_bid = lot.current_bid.unwrap_or(0.0);
                let is_winning = lot.current_bidder_id == Some(user_id);

                summaries.push(UserBidSummary {
                    lot_id: lot.id,
                    lot_title: lot.title.clone(),
                    user_max_bid: max_bid,
                    current_bid,
                    is_winning,
                });
            }
        }

        info!(
            user_id,
            summaries_count = summaries.len(),
            "User bids summary retrieved"
        );

        Ok(summaries)
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
                bids: vec![],
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
                bids: vec![],
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
                bids: vec![],
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
                bids: vec![],
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
                bids: vec![],
            },
        ]
    }
}
