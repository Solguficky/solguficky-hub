defmodule Achievements.Health.Server do
  use GRPC.Server, service: Grpc.Health.V1.Health.Service
  alias Grpc.Health.V1.HealthCheckResponse

  def check(_request, _stream) do
    status = if Achievements.Repo.query("select 1") |> elem(0) == :ok, do: :SERVING, else: :NOT_SERVING
    %HealthCheckResponse{status: status}
  end
end

defmodule Achievements.Endpoint do
  use GRPC.Endpoint
  run Achievements.Health.Server
end
