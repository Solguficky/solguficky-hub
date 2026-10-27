defmodule Achievements.Health.Server do
  @moduledoc """
  `grpc.health.v1.Health/Check` по ADR-054. Пустое имя — liveness: узел жив, базу
  он не спрашивает, иначе лежащая база перезапускала бы под по кругу. Имя
  основного сервиса — readiness: база отвечает. Другое имя — `NOT_FOUND`, как
  требует спецификация grpc.health.
  """
  use GRPC.Server, service: Grpc.Health.V1.Health.Service

  alias Grpc.Health.V1.{HealthCheckRequest, HealthCheckResponse}

  # Полное имя основного gRPC-сервиса контракта, как у остальных сервисов
  # (AppHostNames.Readiness). Сам сервис приносит соседняя задача контракта.
  @readiness "achievements.v1.AchievementsService"

  def readiness_service, do: @readiness

  def check(%HealthCheckRequest{service: service}, _stream) do
    %HealthCheckResponse{status: status(service, &Achievements.Health.database_ready?/0)}
  end

  @doc false
  def status("", _ready?), do: :SERVING
  def status(@readiness, ready?), do: if(ready?.(), do: :SERVING, else: :NOT_SERVING)

  def status(_unknown, _ready?),
    do: raise(GRPC.RPCError, status: :not_found, message: "unknown service")
end

defmodule Achievements.Health do
  @moduledoc false

  @doc "База отвечает на `select 1` за секунду."
  def database_ready? do
    match?({:ok, _}, Achievements.Repo.query("select 1", [], timeout: 1_000))
  rescue
    DBConnection.ConnectionError -> false
  end
end
