defmodule Achievements.Rules.FirstBidTest do
  use ExUnit.Case, async: true

  import Achievements.Test.AuctionEvents
  import Achievements.Test.Orders, only: [definition: 1]

  alias Achievements.Test.RuleRun

  setup do
    auction = uuid()
    [lot1, lot2, lot3] = [uuid(), uuid(), uuid()]

    %{
      auction: auction,
      lot1: lot1,
      lot2: lot2,
      lot3: lot3,
      anya: uuid(),
      borya: uuid(),
      definition: definition("auction_first_bid"),
      started: prebidding_started(auction, [lot1, lot2, lot3]),
      ended: auction_finished(auction, [lot1, lot2, lot3])
    }
  end

  # Аня поставила на лот 2 в 10:00:01, Боря — на лот 1 в 10:00:02, и факт Бори
  # пришёл по стриму раньше.
  defp example(c) do
    [
      c.started,
      lot_opened(c.auction, c.lot1, 1),
      lot_opened(c.auction, c.lot2, 1),
      bid(c.auction, c.lot1, 2, c.borya, at: "2026-11-10T10:00:02Z"),
      bid(c.auction, c.lot2, 2, c.anya, at: "2026-11-10T10:00:01Z"),
      lot_sold(c.auction, c.lot1, 3, c.borya),
      lot_unsold(c.auction, c.lot2, 3),
      c.ended
    ]
  end

  test "the earliest first bid across the lots wins, not the first fact in the stream", c do
    assert RuleRun.holders(c.definition, example(c)) == [c.anya]
  end

  test "it is granted once the auction ended and every known lot has its final fact", c do
    assert [{_, index, _}] = RuleRun.run(c.definition, example(c))
    assert index == length(example(c)) - 1
  end

  # Перемешивание всего стрима здесь не проверяется намеренно: лот, ни одного
  # факта которого правило ещё не видело, барьер не держит, и поздний лот может
  # сменить получателя — риск принят набором («Барьер не доказывает полноту»).
  test "the stream in reverse order gives the same holder on its last fact", c do
    messages = Enum.reverse(example(c))
    assert [{holder, index, _}] = RuleRun.run(c.definition, messages)
    assert holder == c.anya
    assert index == length(messages) - 1
  end

  test "a cancelled auction gives it to no one", c do
    messages = List.replace_at(example(c), -1, auction_cancelled(c.auction, [c.lot1, c.lot2]))
    assert RuleRun.holders(c.definition, messages) == []
  end

  test "a lot of the registry that never opened does not hold the barrier", c do
    # Лот 3 так и не открылся до общего дедлайна: его конечного факта нет.
    assert RuleRun.holders(c.definition, example(c)) == [c.anya]
  end

  test "an end that arrives before the bids of another lot waits for that lot", c do
    messages = [
      c.started,
      lot_opened(c.auction, c.lot2, 1),
      bid(c.auction, c.lot1, 2, c.borya, at: "2026-11-10T10:00:02Z"),
      lot_sold(c.auction, c.lot1, 3, c.borya),
      c.ended,
      bid(c.auction, c.lot2, 2, c.anya, at: "2026-11-10T10:00:01Z"),
      lot_withdrawn(c.auction, c.lot2, 3)
    ]

    assert [{holder, index, _}] = RuleRun.run(c.definition, messages)
    assert holder == c.anya
    assert index == length(messages) - 1
  end

  test "inside a lot the first bid is the least version, not the least occurred_at", c do
    zhenya = uuid()

    messages = [
      c.started,
      bid(c.auction, c.lot1, 3, c.borya, at: "2026-11-10T10:00:00Z"),
      bid(c.auction, c.lot1, 2, c.anya, at: "2026-11-10T10:00:05Z"),
      bid(c.auction, c.lot2, 2, zhenya, at: "2026-11-10T10:00:03Z"),
      lot_sold(c.auction, c.lot1, 4, c.borya),
      lot_sold(c.auction, c.lot2, 3, zhenya),
      c.ended
    ]

    assert RuleRun.holders(c.definition, messages) == [zhenya]
  end

  test "a tie of occurred_at between lots goes to the smaller event id", c do
    [first, second] = Enum.sort([uuid(), uuid()])
    at = "2026-11-10T10:00:00Z"

    messages = [
      c.started,
      bid(c.auction, c.lot1, 2, c.borya, at: at, event_id: second),
      bid(c.auction, c.lot2, 2, c.anya, at: at, event_id: first),
      lot_unsold(c.auction, c.lot1, 3),
      lot_unsold(c.auction, c.lot2, 3),
      c.ended
    ]

    assert RuleRun.holders(c.definition, messages) == [c.anya]
  end

  test "a bid the proxy overtook is still the first bid", c do
    messages = [
      c.started,
      bid(c.auction, c.lot1, 2, c.anya, overtaken: true),
      bid(c.auction, c.lot1, 3, c.borya, origin: :proxy),
      lot_sold(c.auction, c.lot1, 4, c.borya),
      c.ended
    ]

    assert RuleRun.holders(c.definition, messages) == [c.anya]
  end

  test "an auction without a single bid gives it to no one", c do
    messages = [
      c.started,
      lot_opened(c.auction, c.lot1, 1),
      lot_unsold(c.auction, c.lot1, 2),
      c.ended
    ]

    assert RuleRun.holders(c.definition, messages) == []
  end

  test "an auction whose start of trading the rule did not see gives it to no one", c do
    assert RuleRun.holders(c.definition, tl(example(c))) == []
  end

  test "a late bid after the grant does not change the holder", c do
    late = bid(c.auction, c.lot1, 1, c.borya, at: "2026-11-10T09:00:00Z")
    assert RuleRun.holders(c.definition, example(c) ++ [late]) == [c.anya]
  end

  test "repeated facts give no second grant", c do
    assert RuleRun.holders(c.definition, example(c) ++ example(c)) == [c.anya]
  end
end
