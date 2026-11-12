defmodule Achievements.Test.Orders do
  @moduledoc false
  # Порядки прихода фактов. Доставка порядка не обещает, поэтому правила
  # проверяются на всех перестановках короткого хвоста и на перемешиваниях
  # длинной последовательности. Перемешивание засеяно своим номером: упавший
  # порядок воспроизводится тем же номером.

  alias Achievements.Definitions

  @doc "Все перестановки списка."
  def permutations([]), do: [[]]

  def permutations(list),
    do: for(x <- list, rest <- permutations(List.delete(list, x)), do: [x | rest])

  @doc "Перемешивания списка с номерами засева 1..count: `[{seed, order}]`."
  def shuffles(list, count \\ 20) do
    for seed <- 1..count do
      :rand.seed(:exsss, {seed, seed * 7, seed * 13})
      {seed, Enum.shuffle(list)}
    end
  end

  @doc "Определение поставки по коду."
  def definition(code), do: Enum.find(Definitions.delivery(), &(&1.code == code))
end
