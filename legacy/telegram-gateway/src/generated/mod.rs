pub mod nats {
    pub mod commands {
        include!(concat!(env!("OUT_DIR"), "/nats.commands.rs"));
    }
    pub mod events {
        include!(concat!(env!("OUT_DIR"), "/nats.events.rs"));
    }
}

pub mod common {
    include!(concat!(env!("OUT_DIR"), "/common.rs"));
}
