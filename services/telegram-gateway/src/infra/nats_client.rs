use crate::domain::{PlaceBidCommand, SendMessageCommand};
use crate::generated;
use anyhow::{Context, Result};
use async_nats::Client;
use prost::Message;
use tracing::{error, info, warn};

pub struct NatsClient {
    client: Client,
}

impl NatsClient {
    pub async fn connect(url: &str) -> Result<Self> {
        info!("Connecting to NATS at {}", url);

        let client = async_nats::connect(url)
            .await
            .context("Failed to connect to NATS")?;

        info!("Successfully connected to NATS");

        Ok(Self { client })
    }

    pub async fn publish_place_bid(&self, command: PlaceBidCommand) -> Result<()> {
        let proto_cmd = generated::nats::commands::PlaceBidCommand {
            op_id: command.op_id.to_string(),
            event_id: command.event_id,
            lot_id: command.lot_id,
            user_id: command.user_id,
            amount: command.amount,
        };

        let mut buf = Vec::new();
        proto_cmd
            .encode(&mut buf)
            .context("Failed to encode PlaceBidCommand to Protobuf")?;

        let mut headers = async_nats::HeaderMap::new();
        headers.insert("content-type", "application/x-protobuf");
        headers.insert("schema-id", "place-bid-command-v1");

        self.client
            .publish_with_headers(
                "commands.auction.place-bid".to_string(),
                headers,
                buf.into(),
            )
            .await
            .context("Failed to publish PlaceBidCommand to NATS")?;

        info!(
            "Published PlaceBidCommand to NATS (Protobuf): lot_id={}, amount={}",
            proto_cmd.lot_id, proto_cmd.amount
        );
        Ok(())
    }

    pub async fn subscribe_to_events(&self) -> Result<async_nats::Subscriber> {
        let subscriber = self
            .client
            .subscribe("events.auction.>".to_string())
            .await
            .context("Failed to subscribe to auction events")?;

        info!("Subscribed to events.auction.>");
        Ok(subscriber)
    }

    pub async fn subscribe_to_send_message_commands(&self) -> Result<async_nats::Subscriber> {
        let subscriber = self
            .client
            .subscribe("commands.telegram.send-message".to_string())
            .await
            .context("Failed to subscribe to send-message commands")?;

        info!("Subscribed to commands.telegram.send-message");
        Ok(subscriber)
    }
}

pub async fn handle_auction_event(message: async_nats::Message) {
    let subject = &message.subject;

    let schema_id = message
        .headers
        .as_ref()
        .and_then(|h| h.get("schema-id"))
        .map(|v| v.as_str());

    match subject.as_str() {
        "events.auction.bid-placed" => {
            if schema_id != Some("bid-placed-event-v1") {
                warn!(
                    "Unknown or missing schema-id for bid-placed: {:?}",
                    schema_id
                );
            }

            match generated::nats::events::BidPlacedEvent::decode(&*message.payload) {
                Ok(event) => {
                    info!(
                        "Received BidPlacedEvent (Protobuf): lot_id={}, amount={}, user_id={}",
                        event.lot_id, event.amount, event.user_id
                    );

                    if let Some(prev_leader) = event.previous_leader_id {
                        info!("Previous leader was user_id={}", prev_leader);
                    }
                }
                Err(e) => {
                    error!("Failed to decode BidPlacedEvent from Protobuf: {}", e);
                }
            }
        }
        _ => {
            warn!("Unknown event subject: {}", subject);
        }
    }
}

pub async fn handle_send_message_command(message: async_nats::Message) {
    info!(
        "Received SendMessageCommand (JSON fallback): payload_size={}",
        message.payload.len()
    );

    match serde_json::from_slice::<SendMessageCommand>(&message.payload) {
        Ok(cmd) => {
            info!(
                "SendMessageCommand: user_id={}, text={}",
                cmd.user_id, cmd.text
            );
        }
        Err(e) => {
            error!("Failed to deserialize SendMessageCommand: {}", e);
        }
    }
}
