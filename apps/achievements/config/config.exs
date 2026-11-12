import Config

config :achievements, ecto_repos: [Achievements.Repo]

# Ecto пишет каждый запрос на :debug; уровень сервиса — :info.
config :logger, level: :info

# Поля каркаса лога в консоли; в OTLP они уходят атрибутами записи.
config :logger, :default_formatter,
  format: "$time [$level] $message $metadata\n",
  metadata: [
    :service,
    :operation,
    :result,
    :duration_us,
    :grpc_code,
    :request_id,
    :use_case,
    :error_category,
    :error,
    :stack,
    :event_id,
    :published,
    :grpc_port,
    :bus,
    :achievement,
    :stream_seq,
    :granted,
    :outcome,
    :caller,
    :caller_refusal
  ]

# Экспорт выключен, пока среда не дала адрес OTLP (config/runtime.exs).
config :opentelemetry, traces_exporter: :none

import_config "#{config_env()}.exs"
