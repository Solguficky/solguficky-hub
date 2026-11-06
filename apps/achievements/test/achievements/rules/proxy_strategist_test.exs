defmodule Achievements.Rules.ProxyStrategistTest do
  use ExUnit.Case, async: true

  import Achievements.Test.AuctionEvents
  import Achievements.Test.Orders

  alias Achievements.Test.RuleRun

  setup do
    auction = uuid()
    lot = uuid()

    %{
      auction: auction,
      lot: lot,
      vitya: uuid(),
      rival: uuid(),
      definition: definition("auction_proxy_strategist"),
      started: prebidding_started(auction, [lot]),
      ended: auction_finished(auction, [lot])
    }
  end

  defp settle(c, winner),
    do: [lot_sold(c.auction, c.lot, 20, winner), invoice_paid(c.auction, c.lot, winner), c.ended]

  defp proxy_trading(c) do
    [
      bid(c.auction, c.lot, 2, c.rival),
      bid(c.auction, c.lot, 3, c.vitya, origin: :proxy),
      bid(c.auction, c.lot, 4, c.rival, overtaken: true),
      bid(c.auction, c.lot, 5, c.vitya, origin: :proxy),
      bid(c.auction, c.lot, 6, c.rival, overtaken: true),
      bid(c.auction, c.lot, 7, c.vitya, origin: :proxy)
    ]
  end

  test "the winner whose every bid was the proxy gets it once the lot is sold, paid and the auction ended",
       c do
    assert RuleRun.holders(c.definition, [c.started | proxy_trading(c)] ++ settle(c, c.vitya)) ==
             [c.vitya]
  end

  test "one manual bid of the winner before winning by the proxy denies it", c do
    trading = proxy_trading(c) ++ [bid(c.auction, c.lot, 8, c.vitya)]
    assert RuleRun.holders(c.definition, [c.started | trading] ++ settle(c, c.vitya)) == []
  end

  test "a floor bid placed for the winner is a manual bid and denies it", c do
    trading = proxy_trading(c) ++ [bid(c.auction, c.lot, 8, c.vitya, source: :BID_SOURCE_FLOOR)]
    assert RuleRun.holders(c.definition, [c.started | trading] ++ settle(c, c.vitya)) == []
  end

  test "a winner whose bids the rule did not see does not get it", c do
    assert RuleRun.holders(c.definition, [c.started | settle(c, c.vitya)]) == []
  end

  test "sale, payment and end in any of the six orders grant it once, on the last of the three",
       c do
    for order <- permutations(settle(c, c.vitya)) do
      messages = [c.started | proxy_trading(c)] ++ order

      assert [{holder, index, _}] = RuleRun.run(c.definition, messages)
      assert holder == c.vitya
      assert index == length(messages) - 1
    end
  end

  test "a lot paid by the next participant after the winner did not redeem it gives it to no one",
       c do
    messages =
      [c.started | proxy_trading(c)] ++
        [
          lot_sold(c.auction, c.lot, 20, c.vitya),
          invoice_paid(c.auction, c.lot, c.rival),
          c.ended
        ]

    assert RuleRun.holders(c.definition, messages) == []
  end

  test "a cancelled auction gives it to no one, even with the lot sold and paid before", c do
    messages =
      [c.started | proxy_trading(c)] ++
        [
          lot_sold(c.auction, c.lot, 20, c.vitya),
          invoice_paid(c.auction, c.lot, c.vitya),
          auction_cancelled(c.auction, [c.lot])
        ]

    assert RuleRun.holders(c.definition, messages) == []
  end

  test "an auction whose start of trading the rule did not see gives it to no one", c do
    assert RuleRun.holders(c.definition, proxy_trading(c) ++ settle(c, c.vitya)) == []
  end

  test "an auction that started trading before the start date of the set gives it to no one",
       c do
    early = prebidding_started(c.auction, [c.lot], at: "2026-10-25T12:00:00Z")
    assert RuleRun.holders(c.definition, [early | proxy_trading(c)] ++ settle(c, c.vitya)) == []
  end

  test "an online phase that ends the auction is its end, a break is not", c do
    base = [c.started | proxy_trading(c)] ++ Enum.take(settle(c, c.vitya), 2)

    assert RuleRun.holders(
             c.definition,
             base ++ [prebidding_ended(c.auction, [c.lot], :finished)]
           ) ==
             [c.vitya]

    assert RuleRun.holders(
             c.definition,
             base ++ [prebidding_ended(c.auction, [c.lot], :on_break)]
           ) ==
             []
  end

  test "the trading does not stall when both the online phase and the final start", c do
    messages =
      [c.started, final_started(c.auction, [c.lot]) | proxy_trading(c)] ++ settle(c, c.vitya)

    assert RuleRun.holders(c.definition, messages) == [c.vitya]
  end

  test "the start of trading that arrives after the end still settles the lots", c do
    messages = proxy_trading(c) ++ settle(c, c.vitya) ++ [c.started]
    assert [{_, index, _}] = RuleRun.run(c.definition, messages)
    assert index == length(messages) - 1
  end

  test "repeated facts give no second grant", c do
    messages = [c.started | proxy_trading(c)] ++ settle(c, c.vitya)
    assert RuleRun.holders(c.definition, messages ++ messages) == [c.vitya]
  end
end
