defmodule Achievements.Endpoint do
  @moduledoc """
  gRPC-граница сервиса: health и `AchievementsService`. Первой стоит запись
  границы, за ней проверка вызывающего — отказ по токену пишет граница.
  """
  use GRPC.Endpoint

  intercept(Achievements.Grpc.Boundary)
  intercept(Achievements.Grpc.Callers)
  run(Achievements.Health.Server)
  run(Achievements.Server)
end
