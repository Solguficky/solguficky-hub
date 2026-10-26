defmodule Achievements.Telemetry do
  @moduledoc """
  Логи сервиса. `service` — константа сборки и уходит в каждую запись через
  первичные метаданные logger. Когда среда дала адрес OTLP, записи идут ещё и
  в Collector обработчиком `otel_log_handler`: адрес, протокол и имя сервиса
  он читает из `OTEL_EXPORTER_OTLP_*` и `OTEL_SERVICE_NAME` сам. Трейсы
  включает `config/runtime.exs`.
  """

  @service "achievements"

  def service, do: @service

  def setup(export_logs?) do
    :ok = :logger.update_primary_config(%{metadata: %{service: @service}})

    if export_logs? do
      :ok =
        :logger.add_handler(:otel_logs, :otel_log_handler, %{
          level: :info,
          config: %{exporter: {:otel_exporter_logs_otlp, %{}}}
        })
    end

    :ok
  end
end
