defmodule Achievements.Rules.LuckyTest do
  use ExUnit.Case, async: true

  import Achievements.Test.AuctionEvents
  import Achievements.Test.Orders, only: [definition: 1]

  alias Achievements.Test.RuleRun

  setup do
    tickets = for _ <- 1..9, do: uuid()
    %{auction: uuid(), tickets: tickets, definition: definition("auction_lucky")}
  end

  test "the holder of the winning ticket gets it, the other holders do not", c do
    assert RuleRun.holders(c.definition, [raffle_drawn(c.auction, c.tickets, 7)]) ==
             [Enum.at(c.tickets, 6)]
  end

  test "a cancellation of the auction after the draw keeps it", c do
    messages = [raffle_drawn(c.auction, c.tickets, 1), auction_cancelled(c.auction, [])]
    assert RuleRun.holders(c.definition, messages) == [hd(c.tickets)]
  end

  test "no draw gives it to no one", c do
    assert RuleRun.holders(c.definition, [auction_cancelled(c.auction, [])]) == []
  end

  test "a repeated draw gives no second holder of the event", c do
    draw = raffle_drawn(c.auction, c.tickets, 3)
    assert RuleRun.holders(c.definition, [draw, draw]) == [Enum.at(c.tickets, 2)]
  end

  test "each auction has its own holder", c do
    other = uuid()

    messages = [raffle_drawn(c.auction, c.tickets, 1), raffle_drawn(other, c.tickets, 2)]
    assert RuleRun.holders(c.definition, messages) == Enum.take(c.tickets, 2)
  end
end
