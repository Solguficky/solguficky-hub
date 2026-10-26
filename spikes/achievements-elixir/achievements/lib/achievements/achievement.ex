defmodule Achievements.Achievement do
  @moduledoc "Ачивка — единица кода: определение и правило над фактами модуля."

  @callback code() :: String.t()
  @callback title() :: String.t()
  @callback single?() :: boolean()
  @doc "Исполняется внутри транзакции факта с её repo; отдаёт субъектов к выдаче."
  @callback rule(Achievements.Facts.t(), repo :: module()) :: [String.t()]

  def all, do: [Achievements.Rules.Collector, Achievements.Rules.FirstBidder,
                Achievements.Rules.Bidder, Achievements.Rules.FirstPayment]
end
