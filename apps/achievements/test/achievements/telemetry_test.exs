defmodule Achievements.TelemetryTest do
  use ExUnit.Case, async: true

  test "the log handler exports through the OTLP logs exporter, not the trace default" do
    # otel_log_handler читает экспортёр только с верхнего уровня своей конфигурации.
    assert Achievements.Telemetry.log_handler_config()[:exporter] ==
             {:otel_exporter_logs_otlp, %{}}
  end
end
