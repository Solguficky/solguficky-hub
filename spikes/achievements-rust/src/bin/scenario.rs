//! Сценарий спайка (как main у Gleam-спайка): NATS 127.0.0.1:4223 со стримом
//! ACH_FACTS, наполненным publish_facts.py 1; PostgreSQL 127.0.0.1:5433.
use achievements_spike::{actor::{self, Crash, ARMED, STREAM}, rules::{self, Achievement}, store};
use sqlx::{PgPool, Row};
use std::{collections::HashSet, time::Duration};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let pool = PgPool::connect(&std::env::var("DATABASE_URL")
        .unwrap_or("postgres://postgres:spike@127.0.0.1:5433/postgres".into())).await?;
    store::init(&pool).await?;
    let nc = async_nats::connect("127.0.0.1:4223").await?;
    let js = async_nats::jetstream::new(nc);
    let last = js.get_stream(STREAM).await?.info().await?.state.last_sequence as i64;
    println!("stream last_seq {last}");

    // Сбои: коллекционер падает после commit до ack на seq 30 (третья оплата B3),
    // ставочник — внутри транзакции на seq 1 (общий повод с первым ставочником).
    *ARMED.lock().unwrap() = Some(HashSet::from([
        ("collector", 30, Crash::AfterCommit),
        ("bidder", 1, Crash::InsideTx),
    ]));
    let first = [rules::COLLECTOR, rules::FIRST_BIDDER, rules::BIDDER];
    let mut handles = vec![];
    for a in first { handles.push(actor::supervise(a, js.clone(), pool.clone())); }

    // Убить задачу коллекционера снаружи посреди потока: на курсоре >= 20.
    wait_all(&pool, &["collector"], 20).await?;
    println!("killing collector mid-stream, cursor {}", store::cursor(&pool, "collector").await?);
    if let Some(h) = handles[0].1.lock().unwrap().as_ref() { h.abort(); }
    let codes1: Vec<&str> = first.iter().map(|a| a.code).collect();
    wait_all(&pool, &codes1, last).await?;
    report(&pool, "PHASE1", &codes1).await?;

    // Фаза 2: новая ачивка дочитывает стрим с начала — просто ещё одна задача.
    let late = rules::FIRST_PAYMENT;
    handles.push(actor::supervise(late, js.clone(), pool.clone()));
    let all: Vec<&str> = [late].iter().chain(first.iter()).map(|a: &Achievement| a.code).collect();
    wait_all(&pool, &all, last).await?;
    report(&pool, "PHASE2", &all).await?;

    println!("PHASE2 DONE, waiting for phase 3 facts");
    let last3 = loop {
        let l = js.get_stream(STREAM).await?.info().await?.state.last_sequence as i64;
        if l >= last + 6 { break l; }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    wait_all(&pool, &all, last3).await?;
    report(&pool, "PHASE3", &all).await?;
    println!("SCENARIO DONE");
    Ok(())
}

async fn wait_all(pool: &PgPool, codes: &[&str], seq: i64) -> anyhow::Result<()> {
    loop {
        let mut ok = true;
        for c in codes { ok &= store::cursor(pool, c).await? >= seq; }
        if ok { return Ok(()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn report(pool: &PgPool, phase: &str, codes: &[&str]) -> anyhow::Result<()> {
    println!("== {phase}");
    for c in codes { println!("  cursor {c} = {}", store::cursor(pool, c).await?); }
    let counts: Vec<(String, i32)> = sqlx::query("SELECT subject, count FROM rule_state WHERE achievement = 'collector' ORDER BY subject")
        .fetch_all(pool).await?.iter().map(|r| (r.get(0), r.get(1))).collect();
    println!("  collector counts {counts:?}");
    let grants = sqlx::query("SELECT achievement, subject, event_id, seq FROM grant_ ORDER BY 1, 2").fetch_all(pool).await?;
    println!("  grants total {}", grants.len());
    for g in &grants {
        println!("  grant ({}, {}, {}, {})", g.get::<String, _>(0), g.get::<String, _>(1), g.get::<String, _>(2), g.get::<i64, _>(3));
    }
    let ready = store::relay(pool, codes).await?;
    for (occ, seq, items) in &ready { println!("  announce occasion seq {seq} {occ} -> {items:?}"); }
    println!("  announcements {}", ready.len());
    Ok(())
}
