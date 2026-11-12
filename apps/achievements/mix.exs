defmodule Achievements.MixProject do
  use Mix.Project

  def project do
    [
      app: :achievements,
      version: "0.1.0",
      elixir: "~> 1.20",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases(),
      releases: releases()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {Achievements.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # Тесты стартуют приложение сами и только на L1: см. test/test_helper.exs.
  defp aliases, do: [test: "test --no-start"]

  defp deps do
    [
      {:ecto_sql, "~> 3.14"},
      {:postgrex, "~> 0.22"},
      {:grpc_server, "~> 1.0"},
      # Сгенерированный из contracts/proto клиент сервиса (`use GRPC.Stub`)
      # компилируется в каждой среде; адаптер соединения нужен только тестам.
      {:grpc, "~> 1.0"},
      {:protobuf, "~> 0.17"},
      {:gnat, "~> 1.18"},
      {:opentelemetry_api, "~> 1.5"},
      {:opentelemetry, "~> 1.7"},
      {:opentelemetry_exporter, "~> 1.11"},
      # Экспорт логов по OTLP (otel_log_handler) живёт только здесь.
      {:opentelemetry_experimental, "~> 0.6"},
      {:opentelemetry_api_experimental, "~> 0.6"},
      {:mint, "~> 1.9", only: :test},
      {:testcontainers, "~> 2.4", only: :test}
    ]
  end

  # SDK OpenTelemetry стартует раньше приложения, иначе первые спаны и записи
  # лога уходят в no-op провайдер; temporary — его падение не роняет узел.
  defp releases do
    [
      achievements: [
        include_executables_for: [:unix],
        applications: [opentelemetry_exporter: :permanent, opentelemetry: :temporary]
      ]
    ]
  end
end
