use crate::domain::{BidPlacedEvent, SendMessageCommand};
use crate::infra::NatsClient;
use anyhow::Result;
use futures::StreamExt;
use teloxide::{prelude::*, types::ChatId};
use tracing::{debug, error, info, warn};

pub async fn start_event_listener(bot: Bot, nats: NatsClient) -> Result<()> {
    info!("Starting NATS event listener task");

    let mut subscriber = nats.subscribe_to_events().await?;

    tokio::spawn(async move {
        debug!("Event listener task started, waiting for messages");

        while let Some(message) = subscriber.next().await {
            let subject = message.subject.as_str();
            debug!(
                subject = %subject,
                payload_size = message.payload.len(),
                "Received event from NATS"
            );

            match subject {
                "events.auction.bid_placed" => {
                    if let Err(e) = handle_bid_placed_event(&bot, &message.payload).await {
                        error!(error = %e, subject, "Failed to handle bid_placed event");
                    }
                }
                _ => {
                    warn!(subject = %subject, "Unknown event subject, ignoring");
                }
            }
        }

        warn!("Event listener stream ended, task stopped");
    });

    info!("Event listener task spawned successfully");
    Ok(())
}

pub async fn start_send_message_listener(bot: Bot, nats: NatsClient) -> Result<()> {
    info!("Starting send_message command listener task");

    let mut subscriber = nats.subscribe_to_send_message_commands().await?;

    tokio::spawn(async move {
        debug!("send_message listener task started, waiting for commands");

        while let Some(message) = subscriber.next().await {
            debug!(
                payload_size = message.payload.len(),
                "Received send_message command from NATS"
            );

            match serde_json::from_slice::<SendMessageCommand>(&message.payload) {
                Ok(cmd) => {
                    debug!(
                        user_id = cmd.user_id,
                        text_length = cmd.text.len(),
                        "Parsed send_message command, sending to Telegram"
                    );

                    if let Err(e) = bot.send_message(ChatId(cmd.user_id), cmd.text).await {
                        error!(
                            user_id = cmd.user_id,
                            error = %e,
                            "Failed to send message via Telegram Bot API"
                        );
                    } else {
                        info!(
                            user_id = cmd.user_id,
                            "Message sent successfully via Telegram"
                        );
                    }
                }
                Err(e) => {
                    error!(
                        error = %e,
                        payload_size = message.payload.len(),
                        "Failed to deserialize SendMessageCommand"
                    );
                }
            }
        }

        warn!("send_message listener stream ended, task stopped");
    });

    info!("send_message listener task spawned successfully");
    Ok(())
}

async fn handle_bid_placed_event(bot: &Bot, payload: &[u8]) -> Result<()> {
    let event: BidPlacedEvent = serde_json::from_slice(payload)?;

    info!(
        lot_id = event.lot_id,
        amount = event.amount,
        user_id = event.user_id,
        has_previous_leader = event.previous_leader_id.is_some(),
        "Processing BidPlacedEvent"
    );

    if let Some(previous_leader_id) = event.previous_leader_id {
        debug!(
            previous_leader_id,
            new_leader_id = event.user_id,
            "Sending outbid notification to previous leader"
        );

        let message = format!(
            "❗ Ваша ставка на лот {} была перебита!\n\
            Новая максимальная ставка: {} руб.",
            event.lot_id, event.amount
        );

        if let Err(e) = bot.send_message(ChatId(previous_leader_id), message).await {
            error!(
                previous_leader_id,
                error = %e,
                "Failed to send outbid notification"
            );
        } else {
            info!(
                previous_leader_id,
                lot_id = event.lot_id,
                "Outbid notification sent successfully"
            );
        }
    } else {
        debug!(
            lot_id = event.lot_id,
            "First bid on lot, no notification needed"
        );
    }

    Ok(())
}
