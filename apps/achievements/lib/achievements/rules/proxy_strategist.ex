defmodule Achievements.Rules.ProxyStrategist do
  @moduledoc """
  «Прокси-стратег»: лот твой, и все ставки на нём за тебя сделала автоставка
  (docs/product/future/achievements-auction.md, «Прокси-стратег»).

  Победитель торгов W сам оплатил лот, и на лоте есть хотя бы одна автоставка W
  и нет ни одной ручной ставки W — ни из бота, ни зала. Положительное условие не
  даёт пустому входу сойти за «ручных не было». Выдача — на последнем из фактов
  «продажа, оплата, конец аукциона» (`Achievements.Rules.Settlement`).

  Состояние лота — множества ставивших автоставкой и вручную: от порядка
  фактов они не зависят.
  """
  @behaviour Achievements.Rule

  alias Achievements.Rules.Settlement

  @impl true
  def reads, do: [:bid_placed | Settlement.reads()]

  @impl true
  def state_keys(fact), do: Settlement.state_keys(fact)

  @impl true
  def evaluate(fact, states), do: Settlement.evaluate(fact, states, &track/2, &qualifies?/2)

  defp track(%{kind: :bid_placed, data: %{bidder: bidder, origin: origin}}, lot) do
    key = Atom.to_string(origin)
    Map.update(lot, key, [bidder], &Enum.uniq([bidder | &1]))
  end

  defp track(_fact, lot), do: lot

  defp qualifies?(winner, lot),
    do: winner in Map.get(lot, "proxy", []) and winner not in Map.get(lot, "manual", [])
end
