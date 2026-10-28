defmodule Achievements.Application do
  @moduledoc """
  Дерево процесса. Порядок детей — порядок готовности: база, миграции до
  listen (обработчик рассчитывает на готовую схему), метрики, шина и релей
  outbox, каталог с акторами ачивок и последним gRPC-граница (ADR-077,
  дополнение 2026-10-26).
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
        Achievements.Metrics,
        bus(env[:nats], Keyword.get(env, :relay_interval, 1_000)),
        {Achievements.Actors, bus?: env[:nats] != nil, actor: Keyword.get(env, :actor, [])},
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

  # Без адреса шины нет ни релея, ни акторов: строки ждут в outbox, а стрим
  # модуля дочитают акторы, когда адрес появится.
  defp bus(nil, _interval), do: []

  defp bus(settings, interval) do
    [
      {Gnat.ConnectionSupervisor,
       %{name: :gnat, connection_settings: [connection_settings(settings)]}},
      {Achievements.Relay, connection: :gnat, interval: interval}
    ]
  end

  @doc """
  Настройки соединения gnat из `Achievements.Settings.nats!/1`: адрес вместе с
  учёткой, которую Aspire и среда кладут в URL шины. `no_responders` — отказ
  публикации на subject без стрима приходит сразу, а не таймаутом.
  """
  def connection_settings(settings), do: Map.put(settings, :no_responders, true)
end
