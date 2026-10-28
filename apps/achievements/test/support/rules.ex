defmodule Achievements.Test.Rules do
  @moduledoc false
  # Правила тестовых определений: механику реестра проверяют они, а не ачивки
  # поставки (их приносит PER-576).

  defmodule Payer do
    @moduledoc false
    # Ачивка каждому, кто оплатил счёт.
    @behaviour Achievements.Rule

    @impl true
    def reads, do: [:invoice_paid]

    @impl true
    def state_keys(_fact), do: []

    @impl true
    def evaluate(fact, _states), do: {[fact.subject], %{}}
  end

  defmodule TwoLots do
    @moduledoc false
    # Ачивка тому, кто оплатил второй счёт: правило держит число оплат субъекта.
    @behaviour Achievements.Rule

    @impl true
    def reads, do: [:invoice_paid]

    @impl true
    def state_keys(fact), do: [fact.subject]

    @impl true
    def evaluate(fact, states) do
      paid = Map.get(states[fact.subject], "paid", 0) + 1
      granted = if paid == 2, do: [fact.subject], else: []
      {granted, %{fact.subject => %{"paid" => paid}}}
    end
  end
end
