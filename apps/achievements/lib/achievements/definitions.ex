defmodule Achievements.Definitions do
  @moduledoc """
  Определения ачивок поставки. Новая ачивка — определение здесь и, если у неё
  правило, модуль `Achievements.Rule` рядом; картинка — файл в
  `priv/achievements`. Базовый список аукциона заводит PER-575, критерии —
  PER-576, новые ачивки — задачи по просьбе администратора (ADR-077, п. 2).

  Определение, вошедшее хоть в один набор, не удаляется и не меняет код: узел
  с набором, чей код пропал из поставки, не стартует.

  Конфигурация `:definitions` подменяет список: так тесты поднимают узел со
  своими определениями.
  """

  alias Achievements.Definition

  @spec all() :: [Definition.t()]
  def all, do: Application.get_env(:achievements, :definitions, [])
end
