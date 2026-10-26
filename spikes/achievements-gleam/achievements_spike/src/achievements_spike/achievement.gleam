//// Актор ачивки: свой эфемерный consumer от курсора, один факт в полёте,
//// одна транзакция на факт, ack после фиксации.

import achievements_spike/nats
import achievements_spike/rules.{type Achievement}
import achievements_spike/store
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/io
import gleam/list
import gleam/otp/actor

pub const stream = "ACH_FACTS"

pub type Message {
  Poll
}

type State {
  State(
    achievement: Achievement,
    conn: nats.Connection,
    consumer: String,
    self: Subject(Message),
  )
}

@external(erlang, "spike_store_ffi", "register_self")
fn register_self(code: String) -> Nil

pub fn start(a: Achievement) -> actor.StartResult(Subject(Message)) {
  actor.new_with_initialiser(5000, fn(self) {
    register_self(a.code)
    case nats.connect("127.0.0.1", 4222) {
      Error(e) -> Error("nats: " <> e)
      Ok(conn) -> {
        // Курсор — последний зафиксированный номер стрима; читаем со следующего.
        let from = store.dirty_cursor(a.code) + 1
        case nats.create_consumer(conn, stream, from) {
          Error(e) -> Error("consumer: " <> e)
          Ok(consumer) -> {
            io.println(a.code <> ": start from seq " <> int.to_string(from))
            process.send(self, Poll)
            actor.initialised(State(a, conn, consumer, self))
            |> actor.returning(self)
            |> Ok
          }
        }
      }
    }
  })
  |> actor.on_message(handle)
  |> actor.start
}

fn handle(state: State, _msg: Message) -> actor.Next(State, Message) {
  let a = state.achievement
  case nats.fetch(state.conn, stream, state.consumer) {
    Error("empty") -> {
      process.send_after(state.self, 200, Poll)
      actor.continue(state)
    }
    Error(e) -> panic as { "fetch: " <> e }
    Ok(#(seq, subject, ack, body)) -> {
      // Окно «посреди обработки»: факт получен, транзакция ещё не началась.
      process.sleep(15)
      let fact = case rules.decode(subject, body) {
        Ok(f) -> f
        // Тело, которое не разобрать: курсор идёт дальше, как term в доставке.
        Error(_) -> rules.Ignored
      }
      let assert Ok(granted) =
        store.transaction(fn() { apply(a, fact, seq) })
      case store.take_crash(a.code, seq, store.AfterCommit) {
        True -> panic as { a.code <> ": injected crash after commit, before ack" }
        False -> Nil
      }
      nats.ack(state.conn, ack)
      list.each(granted, fn(s) {
        io.println(a.code <> ": granted " <> s <> " at seq " <> int.to_string(seq))
      })
      process.send(state.self, Poll)
      actor.continue(state)
    }
  }
}

/// Тело транзакции: processed, правило, выдача с outbox, курсор.
fn apply(a: Achievement, fact: rules.Fact, seq: Int) -> List(String) {
  let granted = case rules.event_id(fact) {
    Error(Nil) -> []
    Ok(event_id) ->
      case store.processed(a.code, event_id) {
        True -> []
        False -> {
          store.mark_processed(a.code, event_id)
          let subjects =
            a.rule(fact)
            |> list.unique
            |> list.filter(fn(s) { !store.has_grant(a.code, s) })
          list.each(subjects, fn(s) {
            store.insert_grant(a.code, s, a.single, event_id, seq)
          })
          subjects
        }
      }
  }
  case store.take_crash(a.code, seq, store.BeforeCommit) {
    True -> panic as { a.code <> ": injected crash inside transaction" }
    False -> Nil
  }
  store.put_cursor(a.code, seq)
  granted
}
