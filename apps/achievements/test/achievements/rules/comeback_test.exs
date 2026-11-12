defmodule Achievements.Rules.ComebackTest do
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
      gosha: uuid(),
      dasha: uuid(),
      oleg: uuid(),
      definition: definition("auction_comeback"),
      started: prebidding_started(auction, [lot]),
      ended: auction_finished(auction, [lot])
    }
  end

  defp holders(c, trading, winner) do
    RuleRun.holders(c.definition, [c.started | trading] ++ settle(c, winner))
  end

  defp settle(c, winner),
    do: [lot_sold(c.auction, c.lot, 50, winner), invoice_paid(c.auction, c.lot, winner), c.ended]

  # Гоша вёл, Даша перебила, Гоша вернул, Даша снова перебила, Гоша вернул.
  defp fight(c) do
    [
      bid(c.auction, c.lot, 1, c.gosha),
      bid(c.auction, c.lot, 2, c.dasha),
      bid(c.auction, c.lot, 3, c.gosha),
      bid(c.auction, c.lot, 4, c.dasha),
      bid(c.auction, c.lot, 5, c.gosha)
    ]
  end

  test "four changes of the lead with the lead lost and taken back by a bid give it to the winner",
       c do
    assert holders(c, fight(c), c.gosha) == [c.gosha]
  end

  test "a winner who never lost the lead does not get it, however many changes before him", c do
    trading = [
      bid(c.auction, c.lot, 1, c.dasha),
      bid(c.auction, c.lot, 2, c.oleg),
      bid(c.auction, c.lot, 3, c.dasha),
      bid(c.auction, c.lot, 4, c.oleg),
      bid(c.auction, c.lot, 5, c.gosha)
    ]

    assert holders(c, trading, c.gosha) == []
  end

  test "two changes of the lead are not enough", c do
    trading = Enum.take(fight(c), 3)
    assert holders(c, trading, c.gosha) == []
  end

  test "facts of the lot are counted by version, whatever order they arrive in", c do
    for {seed, order} <- shuffles(fight(c)) do
      assert holders(c, order, c.gosha) == [c.gosha], "shuffle #{seed}"
    end
  end

  test "a manual bid the rival's proxy overtook and that proxy answer give no change", c do
    # Без отметки overtaken ставка Даши на версии 4 была бы третьей сменой.
    trading = [
      bid(c.auction, c.lot, 1, c.gosha),
      bid(c.auction, c.lot, 2, c.dasha),
      bid(c.auction, c.lot, 3, c.gosha),
      bid(c.auction, c.lot, 4, c.dasha, overtaken: true),
      bid(c.auction, c.lot, 5, c.gosha, origin: :proxy)
    ]

    assert holders(c, trading, c.gosha) == []
  end

  test "a winner whose last lead came by removing the rival does not get it", c do
    trading =
      Enum.take(fight(c), 4) ++
        [participant_removed(c.auction, c.lot, 5, c.gosha, c.dasha)]

    assert holders(c, trading, c.gosha) == []
  end

  test "removing a bystander while the winner leads does not mark his lead as a removal", c do
    trading = fight(c) ++ [participant_removed(c.auction, c.lot, 6, c.gosha, c.gosha)]
    assert holders(c, trading, c.gosha) == [c.gosha]
  end

  test "a removal from a held lot takes the leader from the held state", c do
    # Удержанный лот ведёт Даша; снятие отдаёт лидерство Гоше — это снятие.
    trading =
      Enum.take(fight(c), 4) ++
        [
          lot_held(c.auction, c.lot, 5, c.dasha),
          participant_removed(c.auction, c.lot, 6, c.gosha, c.dasha, held: true),
          lot_resumed(c.auction, c.lot, 7, c.gosha)
        ]

    assert holders(c, trading, c.gosha) == []
  end

  test "a removal is no change, and neither is a bid into the lot it emptied", c do
    # Если бы снятие или ставка в опустевший лот считались, смен было бы три.
    trading = [
      bid(c.auction, c.lot, 1, c.dasha),
      bid(c.auction, c.lot, 2, c.gosha),
      bid(c.auction, c.lot, 3, c.dasha),
      participant_removed(c.auction, c.lot, 4, nil, c.dasha),
      bid(c.auction, c.lot, 5, c.gosha)
    ]

    assert holders(c, trading, c.gosha) == []
  end

  test "holding a lot for the final and resuming it carry the leader without a change", c do
    trading = [
      bid(c.auction, c.lot, 1, c.gosha),
      bid(c.auction, c.lot, 2, c.dasha),
      bid(c.auction, c.lot, 3, c.gosha),
      lot_held(c.auction, c.lot, 4, c.gosha),
      lot_resumed(c.auction, c.lot, 5, c.gosha),
      bid(c.auction, c.lot, 6, c.dasha),
      bid(c.auction, c.lot, 7, c.gosha)
    ]

    assert holders(c, trading, c.gosha) == [c.gosha]
  end

  test "sale, payment and end in any of the six orders grant it once, on the last of the three",
       c do
    for order <- permutations(settle(c, c.gosha)) do
      messages = [c.started | fight(c)] ++ order
      assert [{holder, index, _}] = RuleRun.run(c.definition, messages)
      assert holder == c.gosha
      assert index == length(messages) - 1
    end
  end

  test "a lot paid by the next participant gives it to no one", c do
    messages =
      [c.started | fight(c)] ++
        [
          lot_sold(c.auction, c.lot, 50, c.gosha),
          invoice_paid(c.auction, c.lot, c.dasha),
          c.ended
        ]

    assert RuleRun.holders(c.definition, messages) == []
  end

  test "a cancelled auction gives it to no one", c do
    messages =
      [c.started | fight(c)] ++
        [
          lot_sold(c.auction, c.lot, 50, c.gosha),
          invoice_paid(c.auction, c.lot, c.gosha),
          auction_cancelled(c.auction, [c.lot])
        ]

    assert RuleRun.holders(c.definition, messages) == []
  end

  test "an auction whose start of trading the rule did not see gives it to no one", c do
    assert RuleRun.holders(c.definition, fight(c) ++ settle(c, c.gosha)) == []
  end

  test "repeated facts give no second grant", c do
    messages = [c.started | fight(c)] ++ settle(c, c.gosha)
    assert RuleRun.holders(c.definition, messages ++ Enum.reverse(messages)) == [c.gosha]
  end
end
