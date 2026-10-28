import Config

# Конфигурация из среды читается при старте узла, в том числе в release.
# Обязательная переменная умолчания не имеет: без неё узел отказывает до
# работы и называет её. Тесты собирают конфигурацию сами: L1 кладёт её в setup_all по адресам контейнеров.
if config_env() != :test do
  database_url =
    System.get_env("ACHIEVEMENTS_DATABASE_URL") ||
      raise "ACHIEVEMENTS_DATABASE_URL is not set: a PostgreSQL URI is required"

  config :achievements, Achievements.Repo, Achievements.DatabaseUrl.repo_options(database_url)

  config :achievements,
    grpc_port: Achievements.Settings.port!("ACHIEVEMENTS_GRPC_PORT", "50051"),
    nats: Achievements.Settings.nats!(System.get_env("ACHIEVEMENTS_NATS_URL")),
    # Вызывающие — колонка Caller раздела «Achievements gRPC» integration.md.
    callers: Achievements.Settings.callers!([:hub_bot, :auction_bot])

  # Адрес OTLP кладёт дашборд Aspire локально и ClusterTelemetry в чарте.
  # Без него экспорт выключен, как у остальных сервисов.
  if System.get_env("OTEL_EXPORTER_OTLP_ENDPOINT") not in [nil, ""] do
    config :opentelemetry, traces_exporter: :otlp
    config :achievements, export_logs: true

    # Метрики (Achievements.Metrics) уходят тем же адресом раз в 30 секунд.
    config :opentelemetry_experimental,
      readers: [
        %{
          id: :otlp,
          module: :otel_metric_reader,
          config: %{exporter: {:otel_exporter_metrics_otlp, %{}}, export_interval_ms: 30_000}
        }
      ]
  end
end
