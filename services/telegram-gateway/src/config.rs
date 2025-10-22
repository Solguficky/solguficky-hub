use figment::{
    providers::{Env, Format, Yaml},
    Figment,
};
use serde::Deserialize;

#[derive(Deserialize, Debug)]
pub struct Application {
    pub host: String,
    pub port: u16,
}

#[derive(Deserialize, Debug)]
pub struct Telegram {
    pub token: String,
}

#[derive(Deserialize, Debug)]
pub struct Nats {
    pub url: String,
}

#[derive(Deserialize, Debug)]
pub struct Settings {
    pub application: Application,
    pub telegram: Telegram,
    pub nats: Nats,
}

pub fn get_configuration() -> Result<Settings, figment::Error> {
    Figment::new()
        .merge(Yaml::file("configuration.yaml"))
        .merge(Env::prefixed("APP_").split("__"))
        .extract()
}
