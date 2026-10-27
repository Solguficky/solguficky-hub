defmodule Achievements.Health.ServerTest do
  use ExUnit.Case, async: true

  alias Achievements.Health.Server

  test "liveness serves without asking the database" do
    assert Server.status("", fn -> flunk("liveness must not ask the database") end) == :SERVING
  end

  test "readiness serves when the database answers" do
    assert Server.status(Server.readiness_service(), fn -> true end) == :SERVING
  end

  test "readiness does not serve when the database is down" do
    assert Server.status(Server.readiness_service(), fn -> false end) == :NOT_SERVING
  end

  test "an unknown service name answers not found" do
    error =
      assert_raise GRPC.RPCError, fn ->
        Server.status("meetups.v1.MeetupsService", fn -> true end)
      end

    assert error.status == GRPC.Status.not_found()
  end
end
