defmodule Achievements.Rules.Comeback do
  @moduledoc """
  «Камбэк»: тебя перебили, а лот всё равно твой
  (docs/product/future/achievements-auction.md, «Камбэк»).

  Победитель торгов W сам оплатил лот, и на лоте не меньше трёх смен лидера, W
  хотя бы раз потерял лидерство, а последнее лидерство W пришло ставкой, а не
  снятием соперника. Выдача — на последнем из фактов «продажа, оплата, конец
  аукциона» (`Achievements.Rules.Settlement`).

  Смены лидера считаются по `version`, а факты приходят в любом порядке, поэтому
  состояние лота — короткий журнал фактов, которые двигают лидера, а свёртка
  идёт на решении. Журнал держит только то, что считает правило: позицию, вид
  и участников, без цен.
  """
  @behaviour Achievements.Rule

  alias Achievements.Rules.Settlement

  @changes 3

  @impl true
  def reads,
    do:
      [:bid_placed, :participant_removed, :lot_held_for_final, :lot_resumed] ++
        Settlement.reads()

  @impl true
  def state_keys(fact), do: Settlement.state_keys(fact)

  @impl true
  def evaluate(fact, states), do: Settlement.evaluate(fact, states, &track/2, &qualifies?/2)

  defp track(%{kind: kind, data: data}, lot)
       when kind in [:bid_placed, :participant_removed, :lot_held_for_final, :lot_resumed] do
    Map.update(lot, "log", [entry(kind, data)], &[entry(kind, data) | &1])
  end

  defp track(_fact, lot), do: lot

  defp entry(:bid_placed, data),
    do: %{"v" => data.version, "k" => "bid", "who" => data.bidder, "over" => data.overtaken}

  defp entry(:participant_removed, data),
    do: %{
      "v" => data.version,
      "k" => "removed",
      "leader" => data.leader,
      "prev" => data.previous_leader
    }

  defp entry(_carry, data), do: %{"v" => data.version, "k" => "carry", "leader" => data.leader}

  defp qualifies?(winner, lot) do
    trail =
      lot |> Map.get("log", []) |> Enum.uniq_by(& &1["v"]) |> Enum.sort_by(& &1["v"]) |> walk()

    trail.changes >= @changes and winner in trail.lost and Map.get(trail.came, winner) == "bid"
  end

  @doc false
  # Свёртка журнала лота в порядке version: подтверждённый лидер, число смен,
  # кто терял лидерство и как каждый в последний раз его получил.
  def walk(entries) do
    Enum.reduce(entries, %{leader: nil, changes: 0, lost: [], came: %{}}, &step/2)
  end

  # Ставку той же командой перебила чужая автоставка: лидерство не пережило
  # команду, смены нет.
  defp step(%{"k" => "bid", "over" => true}, trail), do: trail

  # Ставка самого лидера — его автоставка ответила сопернику — лидерство не
  # передаёт: ни смены, ни нового «как получил».
  defp step(%{"k" => "bid", "who" => who}, %{leader: who} = trail), do: trail

  # Ставка в лот без лидера — не смена: лидерства никто не терял.
  defp step(%{"k" => "bid", "who" => who}, %{leader: nil} = trail),
    do: %{trail | leader: who, came: Map.put(trail.came, who, "bid")}

  defp step(%{"k" => "bid", "who" => who}, %{leader: leader} = trail) do
    %{
      trail
      | leader: who,
        came: Map.put(trail.came, who, "bid"),
        changes: trail.changes + 1,
        lost: Enum.uniq([leader | trail.lost])
    }
  end

  # Снятие ставит лидера по снимку и сменой не считается; лидерство пришло
  # снятием, только если снятие сменило лидера именно на него.
  defp step(%{"k" => "removed", "leader" => leader, "prev" => prev}, trail) do
    came =
      if leader != nil and leader != prev,
        do: Map.put(trail.came, leader, "removal"),
        else: trail.came

    %{trail | leader: leader, came: came}
  end

  # Удержание и возврат в финал переносят лидера из снимка.
  defp step(%{"k" => "carry", "leader" => leader}, trail), do: %{trail | leader: leader}
end
