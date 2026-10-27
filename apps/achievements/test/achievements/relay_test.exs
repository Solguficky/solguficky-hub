defmodule Achievements.RelayTest do
  use ExUnit.Case, async: true

  alias Achievements.Relay

  test "a JetStream publish acknowledgement is accepted" do
    assert Relay.ack(~s({"stream":"ACHIEVEMENTS_EVENTS","seq":7})) == :ok
  end

  test "a stream refusal keeps its description" do
    assert Relay.ack(~s({"error":{"code":503,"description":"no stream"}})) ==
             {:error, "no stream"}
  end

  test "a reply that is not an acknowledgement is a failure" do
    assert {:error, _} = Relay.ack("+OK")
  end
end
