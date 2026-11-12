# Сообщения и сервис grpc.health.v1 (https://github.com/grpc/grpc-proto,
# grpc/health/v1/health.proto) в DSL библиотеки protobuf. Схема не наша, не
# меняется и в contracts/proto не лежит, поэтому генератор сервиса (buf.gen.yaml)
# её не видит. Сервис объявлен без List и Watch — пробы зовут только Check, а
# необъявленный метод отвечает UNIMPLEMENTED.

defmodule Grpc.Health.V1.HealthCheckResponse.ServingStatus do
  @moduledoc false
  use Protobuf,
    enum: true,
    full_name: "grpc.health.v1.HealthCheckResponse.ServingStatus",
    syntax: :proto3

  field :UNKNOWN, 0
  field :SERVING, 1
  field :NOT_SERVING, 2
  field :SERVICE_UNKNOWN, 3
end

defmodule Grpc.Health.V1.HealthCheckRequest do
  @moduledoc false
  use Protobuf, full_name: "grpc.health.v1.HealthCheckRequest", syntax: :proto3

  field :service, 1, type: :string
end

defmodule Grpc.Health.V1.HealthCheckResponse do
  @moduledoc false
  use Protobuf, full_name: "grpc.health.v1.HealthCheckResponse", syntax: :proto3

  field :status, 1, type: Grpc.Health.V1.HealthCheckResponse.ServingStatus, enum: true
end

defmodule Grpc.Health.V1.Health.Service do
  @moduledoc false
  use GRPC.Service, name: "grpc.health.v1.Health"

  rpc(:Check, Grpc.Health.V1.HealthCheckRequest, Grpc.Health.V1.HealthCheckResponse)
end
