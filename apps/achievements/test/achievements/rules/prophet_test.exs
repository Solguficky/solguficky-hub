defmodule Achievements.Rules.ProphetTest do
  use ExUnit.Case, async: true

  import Achievements.Test.AuctionEvents
  import Achievements.Test.Orders, only: [definition: 1]

  alias Achievements.Test.RuleRun

  @expensive :PREDICTION_NOMINATION_MOST_EXPENSIVE_LOT
  @total :PREDICTION_NOMINATION_TOTAL_SALES

  setup do
    %{auction: uuid(), oleg: uuid(), definition: definition("auction_prophet")}
  end

  # Олег угадал «самый дорогой лот», на который ответили восемь человек.
  defp eight_answered(c) do
    [{c.oleg, [{@expensive, :guessed}]} | for(_ <- 1..7, do: {uuid(), [{@expensive, :missed}]})]
  end

  test "a guess in a nomination at least five answered grants it", c do
    assert RuleRun.holders(c.definition, [prediction_results(c.auction, eight_answered(c))]) ==
             [c.oleg]
  end

  test "a nomination three answered gives it to no one, though all of them guessed", c do
    three = for _ <- 1..3, do: {uuid(), [{@total, :guessed}]}
    assert RuleRun.holders(c.definition, [prediction_results(c.auction, three)]) == []
  end

  test "the guess counted is the one in a nomination with enough answers", c do
    # Олег угадал и малую номинацию, и большую: засчитывается большая.
    [{oleg, results} | others] = eight_answered(c)
    small = for _ <- 1..2, do: {uuid(), [{@total, :guessed}]}
    answers = [{oleg, [{@total, :guessed} | results]} | others] ++ small

    assert RuleRun.holders(c.definition, [prediction_results(c.auction, answers)]) == [c.oleg]
  end

  test "the threshold counts answers in the nomination, not all participants of predictions", c do
    # Шесть участников прогнозов, но «общую сумму» назвали двое — и оба угадали.
    answers =
      for(_ <- 1..2, do: {uuid(), [{@total, :guessed}, {@expensive, :missed}]}) ++
        for(_ <- 1..4, do: {uuid(), [{@expensive, :missed}]})

    assert RuleRun.holders(c.definition, [prediction_results(c.auction, answers)]) == []
  end

  test "results entered by hand give it to no one", c do
    results = prediction_results(c.auction, eight_answered(c), manual: true)
    assert RuleRun.holders(c.definition, [results]) == []
  end

  test "repeated results give no second grant", c do
    results = prediction_results(c.auction, eight_answered(c))
    assert RuleRun.holders(c.definition, [results, results]) == [c.oleg]
  end
end
