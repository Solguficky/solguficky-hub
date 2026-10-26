import Config

config :achievements, Achievements.Repo,
  url: System.get_env("DATABASE_URL", "ecto://postgres:spike@127.0.0.1:5432/achievements"),
  pool_size: 10

config :achievements,
  nats_host: System.get_env("NATS_HOST", "127.0.0.1"),
  nats_port: String.to_integer(System.get_env("NATS_PORT", "4222")),
  grpc_port: String.to_integer(System.get_env("GRPC_PORT", "50051")),
  # В сервисе акторы всех ачивок стартуют с приложением; сценарий спайка стартует их сам.
  start_actors: System.get_env("START_ACTORS", "0") == "1"
