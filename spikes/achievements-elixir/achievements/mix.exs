defmodule Achievements.MixProject do
  use Mix.Project

  def project do
    [
      app: :achievements,
      version: "0.1.0",
      elixir: "~> 1.20",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
      mod: {Achievements.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:gnat, "~> 1.18"},
      {:ecto_sql, "~> 3.13"},
      {:postgrex, "~> 0.21"},
      {:protobuf, "~> 0.17"},
      {:grpc, "~> 1.0"},
      {:grpc_server, "~> 1.0"}
    ]
  end
end
