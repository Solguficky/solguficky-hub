use crate::domain::{BidPlacedEvent, SendMessageCommand};
use crate::infra::NatsClient;
use anyhow::Result;
use futures::StreamExt;
use teloxide::{prelude::*, types::ChatId};
use tracing::{error, info};

pub async fn start_event_listener(bot: Bot, nats: NatsClient) -> Result<()> {
    info!("Starting NATS event listener...");

    let mut subscriber = nats.subscribe_to_events().await?;

    tokio::spawn(async move {
        while let Some(message) = subscriber.next().await {
            let subject = message.subject.as_str();
            info!("Received event from NATS: {}", subject);

            match subject {
                "events.auction.bid-placed" => {
                    if let Err(e) = handle_bid_placed_event(&bot, &message.payload).await {
                        error!("Failed to handle bid-placed event: {}", e);
                    }
                }
                _ => {
                    info!("Unknown event subject: {}", subject);
                }
            }
        }

        info!("Event listener stopped");
    });

    Ok(())
}

pub async fn start_send_message_listener(bot: Bot, nats: NatsClient) -> Result<()> {
    info!("Starting send-message command listener...");

    let mut subscriber = nats.subscribe_to_send_message_commands().await?;

    tokio::spawn(async move {
        while let Some(message) = subscriber.next().await {
            info!("Received send-message command from NATS");

            match serde_json::from_slice::<SendMessageCommand>(&message.payload) {
                Ok(cmd) => {
                    if let Err(e) = bot
                        .send_message(ChatId(cmd.user_id), cmd.text)
                        .await
                    {
                        error!("Failed to send message to user {}: {}", cmd.user_id, e);
                    } else {
                        info!("Successfully sent message to user {}", cmd.user_id);
                    }
                }
                Err(e) => {
                    error!("Failed to deserialize SendMessageCommand: {}", e);
                }
            }
        }

        info!("Send-message listener stopped");
    });

    Ok(())
}

async fn handle_bid_placed_event(bot: &Bot, payload: &[u8]) -> Result<()> {
    let event: BidPlacedEvent = serde_json::from_slice(payload)?;

    info!(
        "Bid placed: lot_id={}, amount={}, user_id={}",
        event.lot_id, event.amount, event.user_id
    );

    if let Some(previous_leader_id) = event.previous_leader_id {
        let message = format!(
            "❗ Ваша ставка на лот {} была перебита!\n\
            Новая максимальная ставка: {} руб.",
            event.lot_id, event.amount
        );

        if let Err(e) = bot.send_message(ChatId(previous_leader_id), message).await {
            error!(
                "Failed to send notification to previous leader {}: {}",
                previous_leader_id, e
            );
        } else {
            info!(
                "Sent outbid notification to user {}",
                previous_leader_id
            );
        }
    }

    Ok(())
}

