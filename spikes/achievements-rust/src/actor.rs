//! Актор ачивки — tokio-задача: свой эфемерный consumer от курсора, один факт
//! в полёте, одна транзакция на факт, ack после commit.
use crate::{facts, rules::Achievement, store::{self, Tx}};
use async_nats::jetstream::{self, consumer::{pull, AckPolicy, DeliverPolicy}};
use futures::StreamExt;
use sqlx::PgPool;
use std::{collections::HashSet, sync::Mutex, time::Duration};

pub const STREAM: &str = "ACH_FACTS";
static SLOW_MS: std::sync::LazyLock<u64> =
    std::sync::LazyLock::new(|| std::env::var("SLOW_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(15));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Crash { InsideTx, AfterCommit }

/// Однократные сбои для сценария: (ачивка, seq, где).
pub static ARMED: Mutex<Option<HashSet<(&'static str, u64, Crash)>>> = Mutex::new(None);
fn take_crash(code: &'static str, seq: u64, at: Crash) -> bool {
    ARMED.lock().unwrap().as_mut().is_some_and(|s| s.remove(&(code, seq, at)))
}

pub async fn run(a: Achievement, js: jetstream::Context, pool: PgPool) -> anyhow::Result<()> {
    let from = store::cursor(&pool, a.code).await? as u64 + 1;
    let stream = js.get_stream(STREAM).await?;
    let consumer = stream.create_consumer(pull::Config {
        deliver_policy: DeliverPolicy::ByStartSequence { start_sequence: from },
        ack_policy: AckPolicy::Explicit,
        max_ack_pending: 1,
        inactive_threshold: Duration::from_secs(5),
        ..Default::default()
    }).await?;
    println!("{}: start from seq {from}", a.code);
    let mut msgs = consumer.messages().await?;
    while let Some(msg) = msgs.next().await {
        let msg = msg?;
        let seq = msg.info().map_err(anyhow::Error::msg)?.stream_sequence;
        // Окно «посреди обработки»: факт получен, транзакция ещё не началась.
        tokio::time::sleep(Duration::from_millis(*SLOW_MS)).await;
        // Тело, которое не разобрать: курсор идёт дальше, как term в доставке.
        let fact = facts::decode(&msg.subject, &msg.payload).unwrap_or(facts::Fact::Ignored);
        let mut tx = Tx(pool.begin().await?);
        let mut granted = vec![];
        if let Some(event_id) = fact.event_id() {
            if tx.mark_processed(a.code, event_id).await? {
                for s in a.apply(&mut tx, &fact).await? {
                    if tx.grant(a.code, &s, a.single, event_id, seq as i64).await? { granted.push(s); }
                }
            }
        }
        tx.put_cursor(a.code, seq as i64).await?;
        if take_crash(a.code, seq, Crash::InsideTx) {
            panic!("{}: injected crash inside transaction at seq {seq}", a.code); // tx drop -> rollback
        }
        tx.0.commit().await?;
        if take_crash(a.code, seq, Crash::AfterCommit) {
            panic!("{}: injected crash after commit, before ack at seq {seq}", a.code);
        }
        msg.double_ack().await.map_err(anyhow::Error::msg)?;
        for s in granted { println!("{}: granted {s} at seq {seq}", a.code); }
    }
    anyhow::bail!("{}: message stream ended", a.code)
}

/// Наблюдатель: держит JoinHandle задачи актора и перезапускает её после
/// паники, abort или ошибки. Отдаёт AbortHandle текущей задачи для «убийства» снаружи.
pub fn supervise(a: Achievement, js: jetstream::Context, pool: PgPool)
    -> (tokio::task::JoinHandle<()>, std::sync::Arc<Mutex<Option<tokio::task::AbortHandle>>>) {
    let current = std::sync::Arc::new(Mutex::new(None));
    let cur = current.clone();
    let h = tokio::spawn(async move {
        loop {
            let task = tokio::spawn(run(a, js.clone(), pool.clone()));
            *cur.lock().unwrap() = Some(task.abort_handle());
            match task.await {
                Ok(Ok(())) => return,
                Ok(Err(e)) => eprintln!("{}: error: {e:#}; restart", a.code),
                Err(e) if e.is_panic() => eprintln!("{}: panicked; restart", a.code),
                Err(_) => eprintln!("{}: aborted; restart", a.code),
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    (h, current)
}
