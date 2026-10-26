defmodule SpikeBridge do
  @moduledoc "Elixir-половина смеси: вызывает Gleam и стандартную библиотеку Elixir."
  require Logger

  # Gleam -> Elixir: зовётся из achievements_spike.gleam через @external.
  def hello(name) when is_binary(name) do
    # Elixir -> Gleam: модуль Gleam achievements_spike/facts — атом :achievements_spike@facts,
    # конструктор без полей — атом в snake_case.
    described = :achievements_spike@facts.describe(:lot_sold)
    {:ok, agent} = Agent.start_link(fn -> %{} end)
    Agent.update(agent, &Map.put(&1, :seen, described))
    Logger.info("elixir bridge: #{name} -> #{described}")
    apps = Application.started_applications() |> Enum.map(&elem(&1, 0)) |> Enum.sort()
    "#{String.upcase(name)} #{described} agent=#{Agent.get(agent, & &1.seen)} " <>
      "elixir=#{System.version()} apps=#{inspect(apps)}"
  end
end
