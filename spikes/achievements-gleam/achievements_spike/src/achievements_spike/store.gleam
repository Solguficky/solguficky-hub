//// Типизированная граница к spike_store_ffi (Mnesia вместо PostgreSQL).
//// Функции без префикса dirty_ зовутся только внутри transaction.

import gleam/option.{type Option}

@external(erlang, "spike_store_ffi", "init")
pub fn init() -> Nil

@external(erlang, "spike_store_ffi", "transaction")
pub fn transaction(f: fn() -> a) -> Result(a, String)

@external(erlang, "spike_store_ffi", "processed")
pub fn processed(code: String, event_id: String) -> Bool

@external(erlang, "spike_store_ffi", "mark_processed")
pub fn mark_processed(code: String, event_id: String) -> Nil

@external(erlang, "spike_store_ffi", "count")
pub fn count(code: String, subject: String) -> Int

@external(erlang, "spike_store_ffi", "put_count")
pub fn put_count(code: String, subject: String, count: Int) -> Nil

@external(erlang, "spike_store_ffi", "has_grant")
pub fn has_grant(code: String, subject: String) -> Bool

@external(erlang, "spike_store_ffi", "single_holder")
pub fn single_holder(code: String) -> Option(String)

@external(erlang, "spike_store_ffi", "insert_grant")
pub fn insert_grant(
  code: String,
  subject: String,
  single: Bool,
  occasion_event: String,
  seq: Int,
) -> Nil

@external(erlang, "spike_store_ffi", "cursor")
pub fn dirty_cursor(code: String) -> Int

@external(erlang, "spike_store_ffi", "put_cursor")
pub fn put_cursor(code: String, seq: Int) -> Nil

@external(erlang, "spike_store_ffi", "ready_occasions")
pub fn dirty_ready_occasions(
  codes: List(String),
) -> List(#(String, Int, List(#(String, String))))

@external(erlang, "spike_store_ffi", "mark_published")
pub fn mark_published(occasion_event: String) -> Nil

@external(erlang, "spike_store_ffi", "grants")
pub fn dirty_grants() -> List(#(String, String, String, Int))

pub type CrashPoint {
  BeforeCommit
  AfterCommit
}

@external(erlang, "spike_store_ffi", "arm_crash")
pub fn arm_crash(code: String, seq: Int, at: CrashPoint) -> Nil

@external(erlang, "spike_store_ffi", "take_crash")
pub fn take_crash(code: String, seq: Int, at: CrashPoint) -> Bool
