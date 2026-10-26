defmodule Achievements.Application do
  @moduledoc """
  Дерево процесса. Порядок детей — порядок готовности: база, миграции до
  listen (обработчик рассчитывает на готовую схему), шина и релей outbox,
  место под акторы ачивок и последним gRPC-граница. Акторов пока нет:
  определения и правила приносят соседние задачи (ADR-077, дополнение
  2026-10-26).
  """
  use Application

  require Logger

  @impl true
  def start(_type, _args) do
    env = Application.get_all_env(:achievements)
    Achievements.Telemetry.setup(Keyword.get(env, :export_logs, false))

    children =
      [
        Achievements.Repo,
        {Ecto.Migrator, repos: Application.fetch_env!(:achievements, :ecto_repos), log: :info},
        bus(env[:nats], Keyword.get(env, :relay_interval, 1_000)),
        {DynamicSupervisor, name: Achievements.Actors, strategy: :one_for_one},
        {GRPC.Server.Supervisor,
         endpoint: Achievements.Endpoint,
         port: Keyword.fetch!(env, :grpc_port),
         start_server: true,
         exception_log_filter: {Achievements.Grpc.Boundary, :report_exception?}}
      ]
      |> List.flatten()

    Logger.info("starting",
      grpc_port: env[:grpc_port],
      bus: if(env[:nats], do: "on", else: "off")
    )

    Supervisor.start_link(children, strategy: :one_for_one, name: Achievements.Supervisor)
  end

  # Без адреса шины релея нет: строки ждут в outbox.
  defp bus(nil, _interval), do: []

  defp bus(%{host: host, port: port}, interval) do
    [
      {Gnat.ConnectionSupervisor,
       %{name: :gnat, connection_settings: [%{host: host, port: port, no_responders: true}]}},
      {Achievements.Relay, connection: :gnat, interval: interval}
    ]
  end
end
