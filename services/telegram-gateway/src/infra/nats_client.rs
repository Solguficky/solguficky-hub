use crate::domain::{PlaceBidCommand, SendMessageCommand};
use crate::generated;
use anyhow::{Context, Result};
use async_nats::Client;
use prost::Message;
use tracing::{debug, error, info, warn};

pub struct NatsClient {
    client: Client,
}

impl NatsClient {
    pub async fn connect(url: &str) -> Result<Self> {
        info!(nats_url = %url, "Connecting to NATS");

        let client = async_nats::connect(url)
            .await
            .context("Failed to connect to NATS")?;

        info!(nats_url = %url, "Successfully connected to NATS");

        Ok(Self { client })
    }

    pub async fn publish_place_bid(&self, command: PlaceBidCommand) -> Result<()> {
        let proto_cmd = generated::nats::commands::PlaceBidCommand {
            op_id: command.op_id.to_string(),
            event_id: command.event_id.clone(),
            lot_id: command.lot_id,
            user_id: command.user_id,
            amount: command.amount,
        };

        debug!(
            op_id = %command.op_id,
            event_id = %command.event_id,
            lot_id = command.lot_id,
            user_id = command.user_id,
            amount = command.amount,
            "Encoding PlaceBidCommand to Protobuf"
        );

        let mut buf = Vec::new();
        proto_cmd
            .encode(&mut buf)
            .context("Failed to encode PlaceBidCommand to Protobuf")?;

        let subject = "commands.auction.place_bid";
        debug!(
            subject,
            payload_size = buf.len(),
            "Publishing command to NATS"
        );

        self.client
            .publish(subject.to_string(), buf.into())
            .await
            .context("Failed to publish PlaceBidCommand to NATS")?;

        info!(
            subject,
            lot_id = proto_cmd.lot_id,
            user_id = proto_cmd.user_id,
            amount = proto_cmd.amount,
            "PlaceBidCommand published successfully"
        );
        Ok(())
    }

    pub async fn subscribe_to_events(&self) -> Result<async_nats::Subscriber> {
        let subject = "events.auction.>";
        debug!(subject, "Subscribing to auction events");

        let subscriber = self
            .client
            .subscribe(subject.to_string())
            .await
            .context("Failed to subscribe to auction events")?;

        info!(subject, "Successfully subscribed to auction events");
        Ok(subscriber)
    }

    pub async fn subscribe_to_send_message_commands(&self) -> Result<async_nats::Subscriber> {
        let subject = "commands.telegram.send_message";
        debug!(subject, "Subscribing to send_message commands");

        let subscriber = self
            .client
            .subscribe(subject.to_string())
            .await
            .context("Failed to subscribe to send_message commands")?;

        info!(subject, "Successfully subscribed to send_message commands");
        Ok(subscriber)
    }
}

pub async fn handle_auction_event(message: async_nats::Message) {
    let subject = &message.subject;
    debug!(
        subject = %subject,
        payload_size = message.payload.len(),
        "Processing auction event"
    );

    match subject.as_str() {
        "events.auction.bid_placed" => {
            match generated::nats::events::BidPlacedEvent::decode(&*message.payload) {
                Ok(event) => {
                    info!(
                        subject = %subject,
                        lot_id = event.lot_id,
                        amount = event.amount,
                        user_id = event.user_id,
                        has_previous_leader = event.previous_leader_id.is_some(),
                        "Received BidPlacedEvent"
                    );

                    if let Some(prev_leader) = event.previous_leader_id {
                        debug!(
                            previous_leader_id = prev_leader,
                            new_leader_id = event.user_id,
                            "Leader changed in auction"
                        );
                    }
                }
                Err(e) => {
                    error!(
                        subject = %subject,
                        error = %e,
                        payload_size = message.payload.len(),
                        "Failed to decode BidPlacedEvent from Protobuf"
                    );
                }
            }
        }
        _ => {
            warn!(subject = %subject, "Unknown auction event subject");
        }
    }
}

pub async fn handle_send_message_command(message: async_nats::Message) {
    debug!(
        payload_size = message.payload.len(),
        "Processing SendMessageCommand"
    );

    match serde_json::from_slice::<SendMessageCommand>(&message.payload) {
        Ok(cmd) => {
            info!(
                user_id = cmd.user_id,
                text_length = cmd.text.len(),
                "SendMessageCommand deserialized successfully"
            );
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
