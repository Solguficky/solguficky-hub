//// Сценарий спайка: gleam run (NATS на 127.0.0.1:4222, стрим ACH_FACTS уже
//// наполнен publish_facts.py 1). Фаза 3 ждёт, пока снаружи опубликуют ещё.

import achievements_spike/achievement
import achievements_spike/facts
import achievements_spike/nats
import achievements_spike/rules
import achievements_spike/store
import gleam/erlang/process
import gleam/int
import gleam/io
import gleam/list
import gleam/otp/static_supervisor as sup
import gleam/otp/supervision
import gleam/string

@external(erlang, "Elixir.SpikeBridge", "hello")
fn elixir_hello(name: String) -> String

@external(erlang, "achievements_spike_ffi", "ensure_elixir")
fn ensure_elixir() -> Nil

@external(erlang, "spike_store_ffi", "whereis_ach")
fn whereis(code: String) -> Result(process.Pid, Nil)

@external(erlang, "spike_store_ffi", "kill")
fn kill(pid: process.Pid) -> Nil

pub fn main() -> Nil {
  ensure_elixir()
  io.println("gleam: " <> facts.describe(facts.LotSold))
  io.println("elixir: " <> elixir_hello("spike"))
  store.init()
  let assert Ok(conn) = nats.connect("127.0.0.1", 4222)
  let assert Ok(last) = nats.stream_last_seq(conn, achievement.stream)
  io.println("stream last_seq " <> int.to_string(last))

  // Сбои: коллекционер падает после commit до ack на seq 30 (третья оплата B3),
  // ставочник — внутри транзакции на seq 1 (общий повод с первым ставочником).
  store.arm_crash("collector", 30, store.AfterCommit)
  store.arm_crash("bidder", 1, store.BeforeCommit)

  let first = [rules.collector(), rules.first_bidder(), rules.bidder()]
  let assert Ok(_) =
    list.fold(first, sup.new(sup.OneForOne), fn(b, a) {
      sup.add(b, supervision.worker(fn() { achievement.start(a) }))
    })
    |> sup.restart_tolerance(intensity: 10, period: 5)
    |> sup.start

  // Убить актор коллекционера снаружи посреди потока: на курсоре >= 20.
  wait_all(["collector"], 20)
  case whereis("collector") {
    Ok(pid) -> {
      io.println("killing collector mid-stream, cursor " <> cursor("collector"))
      kill(pid)
    }
    Error(Nil) -> Nil
  }
  wait_all(list.map(first, fn(a) { a.code }), last)
  report("PHASE1", list.map(first, fn(a) { a.code }))

  // Фаза 2: новая ачивка дочитывает стрим с начала. Статический супервизор
  // детей после старта не принимает — новый поддерево.
  let late = rules.first_payment()
  let assert Ok(_) =
    sup.new(sup.OneForOne)
    |> sup.add(supervision.worker(fn() { achievement.start(late) }))
    |> sup.start
  let all = list.map([late, ..first], fn(a) { a.code })
  wait_all(all, last)
  report("PHASE2", all)

  // Фаза 3: снаружи публикуют ещё 6 фактов.
  io.println("PHASE2 DONE, waiting for phase 3 facts")
  let last3 = wait_stream(conn, last + 6)
  wait_all(all, last3)
  report("PHASE3", all)
  io.println("SCENARIO DONE")
}

@external(erlang, "spike_store_ffi", "counts")
fn counts(code: String) -> List(#(String, Int))

fn cursor(code: String) -> String {
  int.to_string(store.dirty_cursor(code))
}

fn wait_all(codes: List(String), seq: Int) -> Nil {
  case list.all(codes, fn(c) { store.dirty_cursor(c) >= seq }) {
    True -> Nil
    False -> {
      process.sleep(100)
      wait_all(codes, seq)
    }
  }
}

fn wait_stream(conn: nats.Connection, seq: Int) -> Int {
  case nats.stream_last_seq(conn, achievement.stream) {
    Ok(l) if l >= seq -> l
    _ -> {
      process.sleep(200)
      wait_stream(conn, seq)
    }
  }
}

fn report(phase: String, codes: List(String)) -> Nil {
  io.println("== " <> phase)
  list.each(codes, fn(c) { io.println("  cursor " <> c <> " = " <> cursor(c)) })
  io.println("  collector counts " <> string.inspect(counts("collector")))
  let grants = store.dirty_grants()
  io.println("  grants total " <> int.to_string(list.length(grants)))
  list.each(grants, fn(g) { io.println("  grant " <> string.inspect(g)) })
  // Релей outbox: один факт на повод, когда водяной знак его прошёл.
  let ready = store.dirty_ready_occasions(codes)
  list.each(ready, fn(o) {
    let #(event, seq, items) = o
    io.println(
      "  announce occasion seq "
      <> int.to_string(seq)
      <> " "
      <> event
      <> " -> "
      <> string.inspect(items),
    )
    store.mark_published(event)
  })
  io.println("  announcements " <> int.to_string(list.length(ready)))
}
