defmodule Achievements.Grpc.Boundary do
  @moduledoc """
  Граница gRPC: спан и одна запись каркаса лога на вызов
  (docs/standards/observability/logging.md). `request_id` и `use_case`
  граница принимает из заголовков `x-request-id` и `x-use-case` и своих не
  рождает: край цепочки — бот. Успех пишется на info, проба здоровья — на
  debug: она идёт каждые несколько секунд и сценария не несёт.
  """
  @behaviour GRPC.Server.Interceptor

  require Logger
  require OpenTelemetry.Tracer, as: Tracer

  @health "/grpc.health.v1.Health/"

  @impl true
  def init(opts), do: opts

  @doc """
  Фильтр отчёта адаптера (`exception_log_filter`): у записи об отказе один
  автор, и отказ кодом gRPC уже записала граница. Прочие исключения адаптер
  пишет сам — среди них те, что случились до цепочки интерцепторов.
  """
  def report_exception?(%{reason: %GRPC.RPCError{}}), do: false
  def report_exception?(_exception), do: true

  @impl true
  def call(req, stream, next, _opts) do
    operation = operation(stream)
    headers = GRPC.Stream.get_headers(stream)
    start = System.monotonic_time()

    Tracer.with_span operation, %{kind: :server} do
      try do
        result = next.(req, stream)
        log(operation, headers, start, :ok, nil)
        result
      rescue
        error ->
          log(operation, headers, start, :error, {error, __STACKTRACE__})
          Tracer.set_status(OpenTelemetry.status(:error, ""))
          reraise error, __STACKTRACE__
      end
    end
  end

  @doc false
  def operation(%{service_name: service, method_name: method}), do: "/#{service}/#{method}"

  @doc false
  def fields(operation, headers, duration_us, outcome) do
    base =
      [
        operation: operation,
        result: if(outcome == :ok, do: "ok", else: "error"),
        duration_us: duration_us,
        grpc_code: grpc_code(outcome)
      ] ++
        optional(:request_id, headers["x-request-id"]) ++
        optional(:use_case, headers["x-use-case"])

    case outcome do
      :ok ->
        base

      {%GRPC.RPCError{} = error, _stack} ->
        base ++
          [
            error_category: category(error.status),
            error: error.message || GRPC.Status.code_name(error.status)
          ]

      {error, stack} ->
        base ++
          [
            error_category: "unexpected",
            error: Exception.message(error),
            stack: Exception.format_stacktrace(stack)
          ]
    end
  end

  defp log(operation, headers, start, outcome, failure) do
    duration_us = System.convert_time_unit(System.monotonic_time() - start, :native, :microsecond)
    fields = fields(operation, headers, duration_us, failure || outcome)

    case failure do
      nil ->
        level = if String.starts_with?(operation, @health), do: :debug, else: :info
        Logger.log(level, "rpc completed", fields)

      {%GRPC.RPCError{status: status}, _} ->
        level = if server_fault?(status), do: :error, else: :warning
        Logger.log(level, "rpc failed", fields)

      _unexpected ->
        Logger.error("rpc failed", fields)
    end
  end

  defp optional(_key, value) when value in [nil, ""], do: []
  defp optional(key, value), do: [{key, value}]

  defp grpc_code(:ok), do: "OK"
  # Имена кодов те же, что пишет Identity (codes.Code.String в Go).
  defp grpc_code({%GRPC.RPCError{status: status}, _}), do: GRPC.Status.code_name(status)
  defp grpc_code(_), do: "Unknown"

  # Словарь error_category стандарта по коду ответа.
  defp category(status) do
    cond do
      status in [GRPC.Status.permission_denied(), GRPC.Status.unauthenticated()] ->
        "authorization"

      status == GRPC.Status.unavailable() ->
        "dependency_unavailable"

      status == GRPC.Status.deadline_exceeded() ->
        "timeout"

      server_fault?(status) ->
        "unexpected"

      true ->
        "invariant"
    end
  end

  defp server_fault?(status),
    do:
      status in [
        GRPC.Status.unknown(),
        GRPC.Status.internal(),
        GRPC.Status.data_loss(),
        GRPC.Status.unimplemented()
      ]
end
