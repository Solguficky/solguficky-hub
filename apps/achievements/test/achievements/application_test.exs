defmodule Achievements.ApplicationTest do
  use ExUnit.Case, async: true

  test "the bus connection keeps the credentials from the address" do
    settings = Achievements.Settings.nats!("nats://nats:secret@bus:4222")
    connection = Achievements.Application.connection_settings(settings)

    assert connection.username == "nats"
    assert connection.password.() == "secret"
    assert connection.no_responders
  end
end
