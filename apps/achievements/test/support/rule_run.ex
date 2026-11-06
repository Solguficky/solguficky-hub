defmodule Achievements.Test.RuleRun do
  @moduledoc false
  # Прогон правила по последовательности сообщений стрима без базы — так же,
  # как Achievements.Ledger: разбор AuctionFacts, виды reads/0, дата начала по
  # occurred_at, дедупликация по event_id, состояние по state_keys через круг
  # JSON (ключи возвращаются строками, как из jsonb) и один держатель у
  # ачивки с получателем :one. Что харнесс совпадает с Ledger, держит L1
  # test/integration/rules_ledger_test.exs.

  alias Achievements.{AuctionFacts, Definition, Fact, Proto}

  @doc "Держатели ачивки в порядке выдачи."
  @spec holders(Definition.t(), [{String.t(), binary()}]) :: [String.t()]
  def holders(definition, messages), do: run(definition, messages) |> Enum.map(&elem(&1, 0))

  @doc """
  Выдачи `{identity, index, event}`: index — номер сообщения, на котором ачивка
  выдана, от нуля; event — событие набора.
  """
  @spec run(Definition.t(), [{String.t(), binary()}]) ::
          [{String.t(), non_neg_integer(), Fact.event()}]
  def run(%Definition{rule: rule} = definition, messages) do
    initial = %{states: %{}, seen: MapSet.new(), grants: []}

    messages
    |> Enum.with_index()
    |> Enum.reduce(initial, fn {{subject, body}, index}, acc ->
      case AuctionFacts.decode(subject, body) do
        :ignored -> acc
        {:error, reason} -> raise "undecodable fact #{subject}: #{reason}"
        {:ok, fact} -> apply_fact(definition, rule, fact, index, acc)
      end
    end)
    |> Map.fetch!(:grants)
    |> Enum.reverse()
  end

  defp apply_fact(definition, rule, %Fact{} = fact, index, acc) do
    cond do
      fact.kind not in rule.reads() ->
        acc

      DateTime.compare(fact.occurred_at, definition.starts_at) == :lt ->
        acc

      MapSet.member?(acc.seen, fact.event_id) ->
        acc

      true ->
        read(definition, rule, fact, index, %{acc | seen: MapSet.put(acc.seen, fact.event_id)})
    end
  end

  defp read(definition, rule, fact, index, acc) do
    keys = rule.state_keys(fact)
    loaded = Map.new(keys, &{&1, Map.get(acc.states, &1, %{})})
    {recipients, states} = rule.evaluate(fact, loaded)

    for r <- recipients,
        not match?({:ok, _}, Proto.uuid(r)),
        do: raise("the rule named a recipient that is not a canonical UUID: #{inspect(r)}")

    states = states |> Jason.encode!() |> Jason.decode!()
    acc = %{acc | states: Map.merge(acc.states, states)}

    # Уникальности реестра: пара «ачивка набора, субъект» и один держатель
    # набора у ачивки с получателем :one.
    Enum.reduce(Enum.uniq(recipients), acc, fn identity, acc ->
      held = for {who, _, event} <- acc.grants, event == fact.event, do: who

      cond do
        identity in held -> acc
        definition.recipients == :one and held != [] -> acc
        true -> %{acc | grants: [{identity, index, fact.event} | acc.grants]}
      end
    end)
  end
end
