defmodule Achievements.SettingsTest do
  use ExUnit.Case, async: false

  alias Achievements.Settings

  @var "ACHIEVEMENTS_TEST_PORT"

  @tokens ["ACHIEVEMENTS_CALLER_TOKEN_TEST_BOT", "ACHIEVEMENTS_CALLER_TOKEN_OTHER_BOT"]

  setup do
    on_exit(fn -> Enum.each([@var | @tokens], &System.delete_env/1) end)
  end

  test "callers read the token of each caller from its own variable" do
    System.put_env("ACHIEVEMENTS_CALLER_TOKEN_TEST_BOT", "t1")
    System.put_env("ACHIEVEMENTS_CALLER_TOKEN_OTHER_BOT", "t2")

    assert Settings.callers!([:test_bot, :other_bot]) == %{test_bot: "t1", other_bot: "t2"}
  end

  test "callers refuse a missing or empty token, naming the variable" do
    System.put_env("ACHIEVEMENTS_CALLER_TOKEN_TEST_BOT", "")

    assert_raise RuntimeError, ~r/ACHIEVEMENTS_CALLER_TOKEN_TEST_BOT/, fn ->
      Settings.callers!([:test_bot])
    end

    assert_raise RuntimeError, ~r/ACHIEVEMENTS_CALLER_TOKEN_OTHER_BOT/, fn ->
      Settings.callers!([:other_bot])
    end
  end

  test "port falls back to the default when the variable is unset" do
    assert Settings.port!(@var, "50051") == 50051
  end

  test "port rejects a value that is not a TCP port, naming the variable" do
    System.put_env(@var, "70000")
    assert_raise RuntimeError, ~r/ACHIEVEMENTS_TEST_PORT/, fn -> Settings.port!(@var, "50051") end
  end

  test "nats is off for an empty address" do
    assert Settings.nats!(nil) == nil
    assert Settings.nats!("") == nil
  end

  test "nats takes host and port and defaults the port to 4222" do
    assert Settings.nats!("nats://bus:4333") == %{host: "bus", port: 4333}
    assert Settings.nats!("nats://bus") == %{host: "bus", port: 4222}
  end

  test "nats takes the credentials Aspire puts into the address" do
    settings = Settings.nats!("nats://nats:p%40ss@bus:4222")

    assert Map.delete(settings, :password) == %{host: "bus", port: 4222, username: "nats"}
    assert settings.password.() == "p@ss"
  end

  test "nats rejects another scheme without echoing the address" do
    error = assert_raise RuntimeError, fn -> Settings.nats!("tls://user:secret@bus:4222") end
    refute error.message =~ "secret"
  end
end
