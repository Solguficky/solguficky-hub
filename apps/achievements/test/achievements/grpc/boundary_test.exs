defmodule Achievements.Grpc.BoundaryTest do
  use ExUnit.Case, async: true

  alias Achievements.Grpc.Boundary

  @operation "/grpc.health.v1.Health/Check"

  test "a success carries the skeleton without error fields" do
    fields = Boundary.fields(@operation, %{}, 42, :ok)

    assert fields == [operation: @operation, result: "ok", duration_us: 42, grpc_code: "OK"]
  end

  test "request_id and use_case come from the incoming headers" do
    headers = %{"x-request-id" => "r-1", "x-use-case" => "achievements.collection"}
    fields = Boundary.fields(@operation, headers, 1, :ok)

    assert fields[:request_id] == "r-1"
    assert fields[:use_case] == "achievements.collection"
  end

  test "an empty header is omitted rather than written empty" do
    refute Keyword.has_key?(
             Boundary.fields(@operation, %{"x-request-id" => ""}, 1, :ok),
             :request_id
           )
  end

  test "an rpc error is categorised by its status code" do
    categories =
      for status <- [:permission_denied, :unavailable, :deadline_exceeded, :not_found, :internal] do
        error = GRPC.RPCError.exception(status: status)
        Boundary.fields(@operation, %{}, 1, {error, []})[:error_category]
      end

    assert categories == [
             "authorization",
             "dependency_unavailable",
             "timeout",
             "invariant",
             "unexpected"
           ]
  end

  test "an rpc error names its grpc code like the other services" do
    error = GRPC.RPCError.exception(status: :not_found, message: "unknown service")
    fields = Boundary.fields(@operation, %{}, 1, {error, []})

    assert fields[:result] == "error"
    assert fields[:grpc_code] == "NotFound"
    assert fields[:error] == "unknown service"
  end

  test "an unexpected exception is written with its stack" do
    {error, stack} =
      try do
        raise "boom"
      rescue
        e -> {e, __STACKTRACE__}
      end

    fields = Boundary.fields(@operation, %{}, 1, {error, stack})

    assert fields[:error_category] == "unexpected"
    assert fields[:grpc_code] == "Unknown"
    assert fields[:stack] =~ "boundary_test.exs"
  end

  test "the adapter does not report a refusal the boundary already wrote" do
    refute Boundary.report_exception?(%GRPC.Server.Adapters.ReportException{
             reason: GRPC.RPCError.exception(status: :not_found)
           })

    assert Boundary.report_exception?(%GRPC.Server.Adapters.ReportException{
             reason: %RuntimeError{message: "boom"}
           })
  end
end
