defmodule Achievements.Rules.Settlement do
  @moduledoc """
  Барьер ачивок за ход торгов лота: «продажа, оплата, конец аукциона» в любом
  порядке (docs/product/future/achievements-auction.md, «Общие правила»).
  Чистые функции над состоянием правила; ход торгов, который ачивка считает,
  правило держит в состоянии лота само и отдаёт сюда предикатом.

  Ключи состояния выводятся из факта:

  - `auction:<id>` — `started` (правило видело начало торгов) и `finished`;
  - `lot:<id>` — `winner` (победитель торгов по `lot_sold`), `paid_by`
    (покупатели по `invoice_paid`), `decided` и то, что пишет правило.

  Конец аукциона загружает лоты своего реестра (`lot_ids` снимка), продажа и
  оплата — аукцион своего лота: решение созревает на последнем из трёх фактов,
  каким бы он ни пришёл. Решённый лот (`decided`) больше не пересчитывается:
  ачивка не отзывается, а поздний факт её не выдаёт.
  """

  alias Achievements.{Fact, Rule}

  @trading_kinds [:trading_started, :auction_finished, :lot_sold, :invoice_paid]

  @doc "Виды фактов барьера; правило добавляет к ним виды своего хода торгов."
  def reads, do: @trading_kinds

  @doc "Ключ аукциона и лотов, которые решаются на этом факте."
  @spec state_keys(Fact.t()) :: [String.t()]
  # Начало торгов тоже грузит лоты реестра: порядок фактов разных журналов не
  # гарантирован, и начало, пришедшее после конца, иначе не решило бы ни одного
  # лота. Реестр заморожен с начала онлайн-этапа, поэтому снимок начала его несёт.
  def state_keys(%Fact{kind: kind, event: {:auction, auction}, data: data})
      when kind in [:trading_started, :auction_finished],
      do: [auction_key(auction) | Enum.map(data.lot_ids, &lot_key/1)]

  def state_keys(%Fact{event: {:auction, auction}, data: %{lot_id: lot}}),
    do: [auction_key(auction), lot_key(lot)]

  @doc """
  Отмечает факт барьера и решает созревшие лоты. `track` — свёртка правила по
  своему факту лота (`fn fact, lot_state -> lot_state end`), `qualifies?` —
  получил ли победитель ачивку по ходу торгов лота
  (`fn winner, lot_state -> boolean end`).
  """
  @spec evaluate(
          Fact.t(),
          %{String.t() => Rule.state()},
          (Fact.t(), Rule.state() ->
             Rule.state()),
          (String.t(), Rule.state() ->
             boolean())
        ) ::
          {[String.t()], %{String.t() => Rule.state()}}
  def evaluate(%Fact{event: {:auction, auction}} = fact, states, track, qualifies?) do
    auction_key = auction_key(auction)
    states = Map.update!(states, auction_key, &mark_auction(&1, fact))
    states = mark_lot(states, fact, track)
    decide(states, auction_key, qualifies?)
  end

  defp mark_auction(state, %Fact{kind: :trading_started}), do: Map.put(state, "started", true)
  defp mark_auction(state, %Fact{kind: :auction_finished}), do: Map.put(state, "finished", true)
  defp mark_auction(state, _fact), do: state

  defp mark_lot(states, %Fact{data: %{lot_id: lot}} = fact, track) do
    Map.update!(states, lot_key(lot), fn state ->
      if state["decided"], do: state, else: mark_lot_fact(state, fact, track)
    end)
  end

  defp mark_lot(states, _fact, _track), do: states

  defp mark_lot_fact(state, %Fact{kind: :lot_sold, data: %{winner: winner}}, _track),
    do: Map.put(state, "winner", winner)

  defp mark_lot_fact(state, %Fact{kind: :invoice_paid, subject: buyer}, _track),
    do: Map.update(state, "paid_by", [buyer], &Enum.uniq([buyer | &1]))

  defp mark_lot_fact(state, fact, track), do: track.(fact, state)

  # Созревший лот решается один раз: выдача победителю, который сам оплатил
  # свой счёт, если его ход торгов удовлетворяет правилу.
  defp decide(states, auction_key, qualifies?) do
    auction = states[auction_key]

    if auction["started"] && auction["finished"] do
      Enum.reduce(states, {[], states}, fn
        {"lot:" <> _ = key, lot}, {granted, acc} ->
          if ripe?(lot) do
            winner = lot["winner"]
            granted = if qualifies?.(winner, lot), do: [winner | granted], else: granted
            {granted, Map.put(acc, key, Map.put(lot, "decided", true))}
          else
            {granted, acc}
          end

        _other, result ->
          result
      end)
    else
      {[], states}
    end
  end

  defp ripe?(lot) do
    not Map.get(lot, "decided", false) and is_binary(lot["winner"]) and
      lot["winner"] in Map.get(lot, "paid_by", [])
  end

  @doc false
  def auction_key(auction), do: "auction:" <> auction

  @doc false
  def lot_key(lot), do: "lot:" <> lot
end
