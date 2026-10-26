//! PostgreSQL: схема и транзакция факта.
use sqlx::{PgPool, Postgres, Row, Transaction};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS cursor (achievement text PRIMARY KEY, seq bigint NOT NULL);
CREATE TABLE IF NOT EXISTS processed (achievement text, event_id text, PRIMARY KEY (achievement, event_id));
CREATE TABLE IF NOT EXISTS rule_state (achievement text, subject text, count int NOT NULL, PRIMARY KEY (achievement, subject));
CREATE TABLE IF NOT EXISTS grant_ (
  achievement text NOT NULL, subject text NOT NULL, single bool NOT NULL,
  event_id text NOT NULL, seq bigint NOT NULL, UNIQUE (achievement, subject));
CREATE UNIQUE INDEX IF NOT EXISTS grant_single ON grant_ (achievement) WHERE single;
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY, occasion text NOT NULL, seq bigint NOT NULL,
  achievement text NOT NULL, subject text NOT NULL, published bool NOT NULL DEFAULT false);
"#;

pub async fn init(pool: &PgPool) -> sqlx::Result<()> {
    sqlx::raw_sql(SCHEMA).execute(pool).await?;
    Ok(())
}

pub async fn cursor(pool: &PgPool, code: &str) -> sqlx::Result<i64> {
    Ok(sqlx::query_scalar("SELECT seq FROM cursor WHERE achievement = $1")
        .bind(code).fetch_optional(pool).await?.unwrap_or(0))
}

pub struct Tx<'c>(pub Transaction<'c, Postgres>);

impl Tx<'_> {
    /// true — факт для этой ачивки новый.
    pub async fn mark_processed(&mut self, code: &str, event_id: &str) -> sqlx::Result<bool> {
        let r = sqlx::query("INSERT INTO processed VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(code).bind(event_id).execute(&mut *self.0).await?;
        Ok(r.rows_affected() == 1)
    }
    pub async fn bump_count(&mut self, code: &str, subject: &str) -> sqlx::Result<i32> {
        sqlx::query_scalar(
            "INSERT INTO rule_state VALUES ($1, $2, 1) ON CONFLICT (achievement, subject)
             DO UPDATE SET count = rule_state.count + 1 RETURNING count")
            .bind(code).bind(subject).fetch_one(&mut *self.0).await
    }
    /// Выдача и её строка outbox; занятая пара или занятая single-ачивка — false.
    pub async fn grant(&mut self, code: &str, subject: &str, single: bool, event_id: &str, seq: i64) -> sqlx::Result<bool> {
        let r = sqlx::query("INSERT INTO grant_ VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING")
            .bind(code).bind(subject).bind(single).bind(event_id).bind(seq).execute(&mut *self.0).await?;
        if r.rows_affected() == 0 { return Ok(false); }
        sqlx::query("INSERT INTO outbox (occasion, seq, achievement, subject) VALUES ($1, $2, $3, $4)")
            .bind(event_id).bind(seq).bind(code).bind(subject).execute(&mut *self.0).await?;
        Ok(true)
    }
    pub async fn put_cursor(&mut self, code: &str, seq: i64) -> sqlx::Result<()> {
        sqlx::query("INSERT INTO cursor VALUES ($1, $2) ON CONFLICT (achievement) DO UPDATE SET seq = $2")
            .bind(code).bind(seq).execute(&mut *self.0).await?;
        Ok(())
    }
}

/// Релей outbox с водяным знаком (ADR-077 п.8): повод уходит одним сообщением,
/// когда все ачивки стрима прошли его номер. Отдаёт (повод, seq, [(ачивка, субъект)]).
pub async fn relay(pool: &PgPool, codes: &[&str]) -> sqlx::Result<Vec<(String, i64, Vec<(String, String)>)>> {
    let mut tx = pool.begin().await?;
    let codes: Vec<String> = codes.iter().map(|s| s.to_string()).collect();
    let rows = sqlx::query(
        "WITH w AS (SELECT min(coalesce(c.seq, 0)) AS mark FROM unnest($1::text[]) a(code)
                    LEFT JOIN cursor c ON c.achievement = a.code)
         UPDATE outbox SET published = true FROM w
         WHERE NOT published AND seq <= w.mark
         RETURNING occasion, seq, achievement, subject")
        .bind(&codes).fetch_all(&mut *tx).await?;
    let mut out: Vec<(String, i64, Vec<(String, String)>)> = vec![];
    let mut rows: Vec<(String, i64, String, String)> =
        rows.iter().map(|r| (r.get(0), r.get(1), r.get(2), r.get(3))).collect();
    rows.sort();
    for (occ, seq, a, s) in rows {
        match out.last_mut() {
            Some(last) if last.0 == occ => last.2.push((a, s)),
            _ => out.push((occ, seq, vec![(a, s)])),
        }
    }
    out.sort_by_key(|o| o.1);
    // Публикация в стрим Achievements здесь — до commit; повтор отсекает Nats-Msg-Id = повод.
    tx.commit().await?;
    Ok(out)
}
