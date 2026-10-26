import achievements_spike/facts
import gleam/io

@external(erlang, "Elixir.SpikeBridge", "hello")
fn elixir_hello(name: String) -> String

@external(erlang, "achievements_spike_ffi", "ensure_elixir")
fn ensure_elixir() -> Nil

pub fn main() -> Nil {
  ensure_elixir()
  io.println("gleam: " <> facts.describe(facts.LotSold))
  io.println("elixir: " <> elixir_hello("spike"))
}
