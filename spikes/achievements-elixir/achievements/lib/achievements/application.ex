defmodule Achievements.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    env = Application.get_all_env(:achievements)

    actors =
      if env[:start_actors],
        do: [Supervisor.child_spec({Task, fn -> Enum.each(Achievements.Achievement.all(), &start_actor/1) end}, id: :boot)],
        else: []

    children =
      [
        Achievements.Repo,
        {Gnat.ConnectionSupervisor,
         %{name: :gnat, connection_settings: [%{host: env[:nats_host], port: env[:nats_port]}]}},
        {DynamicSupervisor, name: Achievements.Actors, strategy: :one_for_one, max_restarts: 20},
        {GRPC.Server.Supervisor, endpoint: Achievements.Endpoint, port: env[:grpc_port], start_server: true}
      ] ++ actors

    Supervisor.start_link(children, strategy: :one_for_one, name: Achievements.Supervisor)
  end

  def start_actor(mod), do: DynamicSupervisor.start_child(Achievements.Actors, {Achievements.Actor, mod})
end
