defmodule Achievements.ApplicationIntegrationTest do
  # L1: настоящий узел над PostgreSQL и NATS в Testcontainers — миграции до
  # listen, health по gRPC и релей outbox в JetStream.
  use ExUnit.Case, async: false

  @moduletag :integration

  import Ecto.Query

  alias Achievements.{Outbox, Relay, Repo}
  alias Gnat.Jetstream.API.Stream
  alias Grpc.Health.V1.{HealthCheckRequest, HealthCheckResponse}
  alias Testcontainers.{Container, PostgresContainer}

  @stream "TEST_EVENTS"

  setup_all do
    {:ok, _} = Application.ensure_all_started(:testcontainers)
    {:ok, _} = Testcontainers.start_link()

    {:ok, postgres} =
      Testcontainers.start_container(
        PostgresContainer.new()
        |> PostgresContainer.with_image("postgres:16-alpine")
      )

    {:ok, nats} =
      Container.new("nats:2")
      # Шина под паролем, как у Aspire и в чарте: релей обязан нести учётку.
      |> Container.with_cmd(["-js", "--user", "nats", "--pass", "relay-secret"])
      |> Container.with_exposed_port(4222)
      |> Container.with_waiting_strategy(
        Testcontainers.LogWaitStrategy.new(~r/Server is ready/, 30_000)
      )
      |> Testcontainers.start_container()

    db = PostgresContainer.connection_parameters(postgres)
    grpc_port = Enum.random(40_000..49_999)

    Application.put_env(:achievements, Repo, Keyword.put(db, :ssl, false))
    Application.put_env(:achievements, :grpc_port, grpc_port)

    nats_url =
      "nats://nats:relay-secret@#{Testcontainers.get_host(nats)}:#{Container.mapped_port(nats, 4222)}"

    Application.put_env(:achievements, :nats, Achievements.Settings.nats!(nats_url))

    # Тики релея тест делает сам, чтобы таймер не забирал строки раньше.
    Application.put_env(:achievements, :relay_interval, :timer.hours(1))

    {:ok, _} = Application.ensure_all_started(:achievements)
    {:ok, _} = Application.ensure_all_started(:grpc)
    wait_for_bus()
    {:ok, _} = Stream.create(:gnat, %Stream{name: @stream, subjects: ["test.>"]})

    {:ok, channel} =
      GRPC.Stub.connect("127.0.0.1:#{grpc_port}", adapter: GRPC.Client.Adapters.Mint)

    on_exit(fn -> Application.stop(:achievements) end)

    %{channel: channel}
  end

  setup do
    Repo.delete_all(Outbox)
    :ok
  end

  test "migrations are applied before the boundary listens", %{channel: channel} do
    assert {:ok, %HealthCheckResponse{}} = check(channel, "")
    assert Repo.exists?(from m in "schema_migrations", where: m.version == 20_261_026_000_000)
  end

  test "readiness serves while the database answers", %{channel: channel} do
    assert {:ok, %HealthCheckResponse{status: :SERVING}} =
             check(channel, Achievements.Health.Server.readiness_service())
  end

  test "liveness serves", %{channel: channel} do
    assert {:ok, %HealthCheckResponse{status: :SERVING}} = check(channel, "")
  end

  test "an unknown service name answers not found", %{channel: channel} do
    assert {:error, %GRPC.RPCError{status: status}} = check(channel, "meetups.v1.MeetupsService")
    assert status == GRPC.Status.not_found()
  end

  test "the relay publishes a row with its event id as the message id and marks it published" do
    row = insert("test.granted", "payload")
    {:ok, _} = Gnat.sub(:gnat, self(), "test.granted")

    assert Relay.run_once() == 1
    assert_receive {:msg, %{body: "payload", headers: headers}}, 5_000

    assert {"nats-msg-id", row.event_id} in Enum.map(headers, fn {k, v} ->
             {String.downcase(k), v}
           end)

    assert Repo.get!(Outbox, row.event_id).published_at
  end

  test "a row the bus refuses stays unpublished and holds back the rows after it" do
    refused = insert("nowhere.granted", "first")
    held = insert("test.granted", "second")

    assert Relay.run_once() == 0
    refute Repo.get!(Outbox, refused.event_id).published_at
    refute Repo.get!(Outbox, held.event_id).published_at
  end

  defp check(channel, service),
    do: Grpc.Health.V1.Health.Stub.check(channel, %HealthCheckRequest{service: service})

  defp insert(subject, payload),
    do: Repo.insert!(%Outbox{event_id: Ecto.UUID.generate(), subject: subject, payload: payload})

  defp wait_for_bus(attempts \\ 50) do
    cond do
      Process.whereis(:gnat) -> :ok
      attempts == 0 -> flunk("NATS connection did not come up")
      true -> Process.sleep(100) && wait_for_bus(attempts - 1)
    end
  end
end
