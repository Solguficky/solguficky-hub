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

  defmodule Flaky do
    @moduledoc false
    # Ачивка каждому, кто оплатил счёт, — пока тест не назвал место дефекта:
    # :evaluate и :state_keys бросают исключение, :state отвечает состоянием,
    # которое не кодируется в JSON, как правило с дефектом.
    @behaviour Achievements.Rule

    def fail(where), do: :persistent_term.put({__MODULE__, :fail}, where)

    defp failing, do: :persistent_term.get({__MODULE__, :fail}, false)

    @impl true
    def reads, do: [:invoice_paid]

    @impl true
    def state_keys(_fact) do
      if failing() == :state_keys, do: raise("defective state keys")
      ["flaky"]
    end

    @impl true
    def evaluate(fact, _states) do
      case failing() do
        :evaluate -> raise("defective rule")
        :state -> {[fact.subject], %{"flaky" => %{"owner" => self()}}}
        _ -> {[fact.subject], %{}}
      end
    end
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
