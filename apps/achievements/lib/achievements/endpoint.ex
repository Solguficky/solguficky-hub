defmodule Achievements.Endpoint do
  @moduledoc """
  gRPC-граница сервиса. Пока на ней только health: методы Achievements
  появятся вместе с контрактом.
  """
  use GRPC.Endpoint

  intercept(Achievements.Grpc.Boundary)
  run(Achievements.Health.Server)
end
