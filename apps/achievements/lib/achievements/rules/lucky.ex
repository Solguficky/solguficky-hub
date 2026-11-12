defmodule Achievements.Rules.Lucky do
  @moduledoc """
  «Везунчик»: твой билет выпал в розыгрыше
  (docs/product/future/achievements-auction.md, «Везунчик»).

  Получатель — владелец выигравшего билета факта `raffle_drawn`; ручной итог
  администратора приходит тем же фактом. Итог розыгрыша не разворачивается,
  поэтому отмена аукциона после жеребьёвки ачивку оставляет. Состояния нет.
  """
  @behaviour Achievements.Rule

  @impl true
  def reads, do: [:raffle_drawn]

  @impl true
  def state_keys(_fact), do: []

  @impl true
  def evaluate(%{subject: holder}, _states), do: {[holder], %{}}
end
