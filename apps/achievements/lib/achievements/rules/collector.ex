defmodule Achievements.Rules.Collector do
  @moduledoc """
  «Коллекционер»: три лота одного аукциона — твои, и все оплачены
  (docs/product/future/achievements-auction.md, «Коллекционер»).

  Покупатель — `InvoiceState.winner_id` оплаченного счёта, поэтому лот,
  переданный после невыкупа и оплаченный новым покупателем, считается ему. Ход
  торгов и отмена аукциона неважны. Выдача — на третьем разном оплаченном счёте
  аукциона.

  Состояние — счета, оплаченные покупателем в аукционе: правило считает их
  число и больше ничего.
  """
  @behaviour Achievements.Rule

  @lots 3

  @impl true
  def reads, do: [:invoice_paid]

  @impl true
  def state_keys(%{event: {:auction, auction}, subject: buyer}), do: [key(auction, buyer)]

  @impl true
  def evaluate(
        %{event: {:auction, auction}, subject: buyer, data: %{invoice_id: invoice}},
        states
      ) do
    key = key(auction, buyer)
    paid = Enum.uniq([invoice | Map.get(states[key], "invoices", [])])
    granted = if length(paid) >= @lots, do: [buyer], else: []
    {granted, %{key => %{"invoices" => paid}}}
  end

  defp key(auction, buyer), do: "buyer:" <> auction <> ":" <> buyer
end
