defmodule Achievements.Rules.Prophet do
  @moduledoc """
  «Пророк»: твой прогноз сбылся
  (docs/product/future/achievements-auction.md, «Пророк»).

  Получатель — тот, кто угадал номинацию, в которой ответили не меньше пяти
  человек; порог стоит на ответивших в самой номинации, а не на всех участниках
  прогнозов. Итоги, внесённые руками (`manual`), Пророка не дают. Состояния нет:
  решение — на одном факте `prediction_results_settled`.
  """
  @behaviour Achievements.Rule

  @answered 5

  @impl true
  def reads, do: [:prediction_results_settled]

  @impl true
  def state_keys(_fact), do: []

  @impl true
  def evaluate(%{data: %{manual: true}}, _states), do: {[], %{}}

  def evaluate(%{data: %{participations: participations}}, _states) do
    answered =
      participations
      |> Enum.uniq_by(&{&1.participant, &1.nomination})
      |> Enum.frequencies_by(& &1.nomination)

    guessed =
      for p <- participations,
          p.guessed,
          Map.get(answered, p.nomination, 0) >= @answered,
          uniq: true,
          do: p.participant

    {guessed, %{}}
  end
end
