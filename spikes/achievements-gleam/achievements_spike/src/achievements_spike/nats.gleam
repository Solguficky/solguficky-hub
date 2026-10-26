//// Типизированная граница к spike_nats_ffi.

pub type Connection

@external(erlang, "spike_nats_ffi", "connect")
pub fn connect(host: String, port: Int) -> Result(Connection, String)

@external(erlang, "spike_nats_ffi", "close")
pub fn close(conn: Connection) -> Nil

@external(erlang, "spike_nats_ffi", "create_consumer")
pub fn create_consumer(
  conn: Connection,
  stream: String,
  start_seq: Int,
) -> Result(String, String)

@external(erlang, "spike_nats_ffi", "stream_last_seq")
pub fn stream_last_seq(conn: Connection, stream: String) -> Result(Int, String)

/// Один факт: номер в стриме, subject факта, subject для ack и тело.
@external(erlang, "spike_nats_ffi", "fetch")
pub fn fetch(
  conn: Connection,
  stream: String,
  consumer: String,
) -> Result(#(Int, String, String, BitArray), String)

@external(erlang, "spike_nats_ffi", "ack")
pub fn ack(conn: Connection, ack_subject: String) -> Nil
