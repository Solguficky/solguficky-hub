//// Вход: Gleam main стартует Elixir-оболочку и выбирает режим по SCENARIO.

import achievements_real/facts
import gleam/io

@external(erlang, "Elixir.AchievementsReal.Shell", "start")
fn start_shell() -> Nil

@external(erlang, "Elixir.AchievementsReal.Shell", "serve")
fn serve() -> Nil

@external(erlang, "Elixir.AchievementsReal.Scenario", "run")
fn scenario() -> Nil


@external(erlang, "achievements_real_ffi", "env_flag")
fn env_flag(name: String) -> Bool

pub fn main() -> Nil {
  io.println("gleam core: " <> facts.describe(facts.LotSold))
  start_shell()
  case env_flag("SCENARIO") {
    True -> scenario()
    False -> serve()
  }
}
