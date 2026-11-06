defmodule Achievements.Rules.FirstBid do
  @moduledoc """
  «Первая ставка»: первая ставка аукциона — твоя
  (docs/product/future/achievements-auction.md, «Первая ставка»).

  На каждом лоте первая ставка — с наименьшим `version`; из первых ставок лотов
  побеждает меньший `occurred_at`, ничья — меньший `event_id`. Выдача — один
  раз, когда правило видело начало торгов и конец аукциона и у каждого
  известного лота есть конечный факт. Известный лот — тот, чей `lot_opened` или
  `bid_placed` правило видело: лот реестра, который так и не открылся, барьер не
  держит.

  Состояние — один ключ аукциона: флаги начала и конца, `decided` и по лоту
  первая ставка и отметки «известен» и «закрыт». Поздняя ставка после решения
  получателя не меняет: выдача не пересчитывается.
  """
  @behaviour Achievements.Rule

  @terminal [:lot_sold, :lot_unsold, :lot_withdrawn]

  @impl true
  def reads, do: [:trading_started, :auction_finished, :lot_opened, :bid_placed | @terminal]

  @impl true
  def state_keys(%{event: {:auction, auction}}), do: [key(auction)]

  @impl true
  def evaluate(%{event: {:auction, auction}} = fact, states) do
    key = key(auction)
    state = states[key]

    if state["decided"] do
      {[], %{}}
    else
      state = track(fact, state)

      case winner(state) do
        nil -> {[], %{key => state}}
        bidder -> {[bidder], %{key => Map.put(state, "decided", true)}}
      end
    end
  end

  defp track(%{kind: :trading_started}, state), do: Map.put(state, "started", true)
  defp track(%{kind: :auction_finished}, state), do: Map.put(state, "finished", true)

  defp track(%{kind: :lot_opened, data: %{lot_id: lot}}, state),
    do: update_lot(state, lot, &Map.put(&1, "known", true))

  defp track(%{kind: :bid_placed, data: data} = fact, state) do
    bid = %{
      "v" => data.version,
      "at" => DateTime.to_iso8601(fact.occurred_at),
      "id" => fact.event_id,
      "who" => data.bidder
    }

    update_lot(state, data.lot_id, fn lot ->
      lot = Map.put(lot, "known", true)

      case lot["first"] do
        %{"v" => v} when v <= data.version -> lot
        _ -> Map.put(lot, "first", bid)
      end
    end)
  end

  defp track(%{kind: kind, data: %{lot_id: lot}}, state) when kind in @terminal,
    do: update_lot(state, lot, &Map.put(&1, "closed", true))

  defp update_lot(state, lot, fun),
    do: Map.update(state, "lots", %{lot => fun.(%{})}, &Map.update(&1, lot, fun.(%{}), fun))

  defp winner(state) do
    lots = Map.values(Map.get(state, "lots", %{}))
    known = Enum.filter(lots, & &1["known"])

    if state["started"] && state["finished"] && Enum.all?(known, & &1["closed"]) do
      known
      |> Enum.map(& &1["first"])
      |> Enum.reject(&is_nil/1)
      |> Enum.min_by(&{instant(&1["at"]), &1["id"]}, &earlier?/2, fn -> nil end)
      |> case do
        nil -> nil
        bid -> bid["who"]
      end
    end
  end

  defp instant(value) do
    {:ok, at, _} = DateTime.from_iso8601(value)
    at
  end

  defp earlier?({a, id_a}, {b, id_b}) do
    case DateTime.compare(a, b) do
      :lt -> true
      :gt -> false
      :eq -> id_a <= id_b
    end
  end

  defp key(auction), do: "auction:" <> auction
end
