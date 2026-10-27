import Config

# Тесты стартуют приложение сами и только на L1, с базой из контейнера:
# test/integration/application_test.exs.
config :logger, level: :warning
