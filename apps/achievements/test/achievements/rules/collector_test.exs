defmodule Achievements.Rules.CollectorTest do
  use ExUnit.Case, async: true

  import Achievements.Test.AuctionEvents
  import Achievements.Test.Orders, only: [definition: 1]

  alias Achievements.Test.RuleRun

  setup do
    %{auction: uuid(), zhenya: uuid(), definition: definition("auction_collector")}
  end

  defp paid(auction, buyer, opts \\ []), do: invoice_paid(auction, uuid(), buyer, opts)

  test "three paid lots of one auction grant it on the third payment", c do
    messages = for _ <- 1..3, do: paid(c.auction, c.zhenya)
    assert [{holder, 2, _}] = RuleRun.run(c.definition, messages)
    assert holder == c.zhenya
  end

  test "two paid lots and a third invoice waiting for payment do not grant it", c do
    assert RuleRun.holders(c.definition, [paid(c.auction, c.zhenya), paid(c.auction, c.zhenya)]) ==
             []
  end

  test "two paid lots in each of two auctions do not grant it", c do
    other = uuid()
    messages = for a <- [c.auction, other, c.auction, other], do: paid(a, c.zhenya)
    assert RuleRun.holders(c.definition, messages) == []
  end

  test "one invoice paid three times counts once", c do
    invoice = uuid()
    lot = uuid()
    messages = for _ <- 1..3, do: invoice_paid(c.auction, lot, c.zhenya, invoice: invoice)
    assert RuleRun.holders(c.definition, messages) == []
  end

  test "a lot paid by the next participant after the winner did not redeem it counts to the payer",
       c do
    winner = uuid()
    lot = uuid()

    messages = [
      lot_sold(c.auction, lot, 9, winner),
      paid(c.auction, c.zhenya),
      paid(c.auction, c.zhenya),
      invoice_paid(c.auction, lot, c.zhenya)
    ]

    assert RuleRun.holders(c.definition, messages) == [c.zhenya]
  end

  test "a cancellation of the auction after the payments keeps it", c do
    messages =
      for(_ <- 1..3, do: paid(c.auction, c.zhenya)) ++ [auction_cancelled(c.auction, [])]

    assert RuleRun.holders(c.definition, messages) == [c.zhenya]
  end

  test "payments before the start date of the set are not counted", c do
    early = for _ <- 1..2, do: paid(c.auction, c.zhenya, at: "2026-11-01T12:00:00Z")
    assert RuleRun.holders(c.definition, early ++ [paid(c.auction, c.zhenya)]) == []
  end

  test "repeated payments give no second grant", c do
    messages = for _ <- 1..4, do: paid(c.auction, c.zhenya)
    assert RuleRun.holders(c.definition, messages ++ messages) == [c.zhenya]
  end
end
