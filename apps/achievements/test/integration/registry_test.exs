defmodule Achievements.RegistryIntegrationTest do
  # L1: настоящий узел над PostgreSQL и NATS в Testcontainers с тестовыми
  # определениями — акторы читают AUCTION_EVENTS, реестр пишет выдачи и
  # outbox, релей выносит факт выдачи, gRPC отдаёт коллекцию и набор.
  use ExUnit.Case, async: false

  @moduletag :integration

  import Ecto.Query

  alias Achievements.{Definition, Maintenance, Outbox, Relay, Repo}
  alias Achievements.Test.Rules
  alias Achievements.V1
  alias Auction.V1.{InvoiceEvent, InvoicePaid, InvoiceState}
  alias Gnat.Jetstream.API.Stream
  alias Testcontainers.{Container, PostgresContainer}

  @hub_token "hub-bot-token"
  @auction_token "auction-bot-token"

  # Дата начала «mid» — между фактами сценария набора.
  @definitions [
    {"first_buyer", :one, :rule, ~U[2026-01-01 00:00:00Z], Rules.Payer},
    {"buyer", :many, :rule, ~U[2026-01-01 00:00:00Z], Rules.Payer},
    {"two_lots", :many, :rule, ~U[2026-01-01 00:00:00Z], Rules.TwoLots},
    {"thanks", :many, :manual, ~U[2026-01-01 00:00:00Z], nil},
    {"mid", :many, :rule, ~U[2026-10-05 00:00:00Z], Rules.Payer},
    {"late", :many, :rule, ~U[2100-01-01 00:00:00Z], Rules.Payer}
  ]

  @rule_codes ~w(first_buyer buyer two_lots mid late)

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
      |> Container.with_cmd(["-js"])
      |> Container.with_exposed_port(4222)
      |> Container.with_waiting_strategy(
        Testcontainers.LogWaitStrategy.new(~r/Server is ready/, 30_000)
      )
      |> Testcontainers.start_container()

    image_dir = Path.join(System.tmp_dir!(), "achievements-#{System.unique_integer([:positive])}")
    File.mkdir_p!(image_dir)
    File.write!(Path.join(image_dir, "buyer.png"), "png bytes")

    grpc_port = Enum.random(40_000..49_999)
    db = PostgresContainer.connection_parameters(postgres)
    nats_url = "nats://#{Testcontainers.get_host(nats)}:#{Container.mapped_port(nats, 4222)}"

    Application.put_env(:achievements, Repo, Keyword.put(db, :ssl, false))
    Application.put_env(:achievements, :grpc_port, grpc_port)
    Application.put_env(:achievements, :nats, Achievements.Settings.nats!(nats_url))
    Application.put_env(:achievements, :relay_interval, :timer.hours(1))

    Application.put_env(:achievements, :callers, %{
      hub_bot: @hub_token,
      auction_bot: @auction_token
    })

    Application.put_env(:achievements, :definitions, definitions(image_dir))
    Application.put_env(:achievements, :actor, expires_ms: 300, retry_ms: 200)

    {:ok, _} = Application.ensure_all_started(:achievements)
    {:ok, _} = Application.ensure_all_started(:grpc)
    wait_until(fn -> Process.whereis(:gnat) end, "NATS connection did not come up")

    {:ok, _} =
      Stream.create(:gnat, %Stream{name: "AUCTION_EVENTS", subjects: ["events.auction.>"]})

    {:ok, _} =
      Stream.create(:gnat, %Stream{
        name: "ACHIEVEMENTS_EVENTS",
        subjects: ["events.achievements.>"]
      })

    {:ok, channel} =
      GRPC.Stub.connect("127.0.0.1:#{grpc_port}", adapter: GRPC.Client.Adapters.Mint)

    on_exit(fn ->
      Application.stop(:achievements)
      Enum.each([:definitions, :callers, :actor], &Application.delete_env(:achievements, &1))
    end)

    %{channel: channel}
  end

  setup do
    Repo.delete_all(Outbox)
    :ok
  end

  test "a repeated incoming fact gives neither a second grant nor a second grant fact" do
    auction = uuid()
    buyer = uuid()
    fact = paid(auction, buyer, ~U[2026-10-10 12:00:00Z])

    publish(fact)
    publish(fact)

    assert holders(auction, "buyer") == [buyer]
    assert holders(auction, "first_buyer") == [buyer]

    assert outbox_facts(buyer) |> Enum.map(& &1.state.grant.achievement_code) |> Enum.sort() == [
             "buyer",
             "first_buyer",
             "mid"
           ]
  end

  test "a cancelled grant returns neither by a repeated fact nor by a new trigger of the rule" do
    auction = uuid()
    buyer = uuid()
    fact = paid(auction, buyer, ~U[2026-10-10 12:00:00Z])
    publish(fact)

    [grant] = for g <- Maintenance.grants(buyer), g.achievement_code == "buyer", do: g
    assert Maintenance.cancel_grant(grant.id) == :ok
    Repo.delete_all(Outbox)

    publish(fact)
    publish(paid(auction, buyer, ~U[2026-10-11 12:00:00Z]))

    assert holders(auction, "buyer") == []
    assert Enum.find(Maintenance.grants(buyer), &(&1.id == grant.id)).state == "cancelled"
    refute "buyer" in Enum.map(outbox_facts(buyer), & &1.state.grant.achievement_code)

    assert Maintenance.restore_grant(grant.id) == :ok
    assert holders(auction, "buyer") == [buyer]
  end

  test "a one-holder achievement goes to the first of two triggers in stream order" do
    auction = uuid()
    [first, second] = [uuid(), uuid()]

    publish_all([
      paid(auction, first, ~U[2026-10-10 12:00:00Z]),
      paid(auction, second, ~U[2026-10-10 12:00:01Z])
    ])

    assert holders(auction, "first_buyer") == [first]
    assert holders(auction, "buyer") |> Enum.sort() == Enum.sort([first, second])
  end

  test "an achievement starting after the facts of an event stays out of its set, and one starting before them joins the fixed set" do
    auction = uuid()
    buyer = uuid()

    publish(paid(auction, buyer, ~U[2026-10-01 12:00:00Z]))
    assert members(auction) == ~w(buyer first_buyer thanks two_lots)

    publish(paid(auction, uuid(), ~U[2026-10-06 12:00:00Z]))
    assert members(auction) == ~w(buyer first_buyer mid thanks two_lots)
    refute "late" in members(auction)
  end

  test "a rule counts with its own state across facts" do
    auction = uuid()
    buyer = uuid()

    publish(paid(auction, buyer, ~U[2026-10-10 12:00:00Z]))
    assert holders(auction, "two_lots") == []

    publish(paid(auction, buyer, ~U[2026-10-10 13:00:00Z]))
    assert holders(auction, "two_lots") == [buyer]
  end

  test "an undecodable fact moves every actor past it without a grant" do
    seq = publish_raw("events.auction.invoice_paid", <<255, 255, 255>>)
    assert Repo.aggregate(Outbox, :count) == 0
    assert Enum.all?(@rule_codes -- ["late"], &(cursor(&1) >= seq))
  end

  test "an actor restarted by its supervisor resumes after its cursor" do
    auction = uuid()
    buyer = uuid()
    publish(paid(auction, buyer, ~U[2026-10-10 12:00:00Z]))

    [buyer_actor] =
      for {{Achievements.Actor, "buyer"}, pid, _, _} <-
            Supervisor.which_children(Achievements.Actors),
          do: pid

    Process.exit(buyer_actor, :kill)
    wait_until(fn -> restarted?("buyer", buyer_actor) end, "the buyer actor was not restarted")

    other = uuid()
    publish(paid(auction, other, ~U[2026-10-10 12:30:00Z]))

    assert holders(auction, "buyer") |> Enum.sort() == Enum.sort([buyer, other])
    assert length(outbox_facts(buyer)) == 3
  end

  test "the relay publishes each grant as its own fact with the incoming event as its cause" do
    auction = uuid()
    buyer = uuid()
    fact = paid(auction, buyer, ~U[2026-10-10 12:00:00Z])
    publish(fact)

    {:ok, _} = Gnat.sub(:gnat, self(), "events.achievements.achievement_granted")
    assert Relay.run_once() == 3

    received =
      for _ <- 1..3 do
        assert_receive {:msg, %{body: body}}, 5_000
        V1.AchievementGrantEvent.decode(body)
      end

    assert Enum.map(received, & &1.state.cause_id) |> Enum.uniq() == [fact.event_id]
    assert Enum.map(received, & &1.state.grant.identity_id) |> Enum.uniq() == [buyer]
    assert Enum.map(received, & &1.achievement_grant_id) |> Enum.uniq() |> length() == 3
  end

  test "the own collection lists live grants with their definitions", %{channel: channel} do
    auction = uuid()
    buyer = uuid()
    publish(paid(auction, buyer, ~U[2026-10-10 12:00:00Z]))

    assert {:ok, %V1.MyAchievements{achievements: held}} =
             V1.AchievementsService.Stub.list_my_achievements(
               channel,
               %V1.ListMyAchievementsRequest{identity_id: buyer},
               metadata: auth(@auction_token)
             )

    assert Enum.map(held, & &1.achievement.code) |> Enum.sort() == ["buyer", "first_buyer", "mid"]
    assert Enum.all?(held, &(&1.grant.event == %V1.EventRef{kind: {:auction_id, auction}}))
    assert Enum.find(held, &(&1.achievement.code == "buyer")).achievement.image.version != ""
  end

  test "a fixed set lists its achievements in catalog order with holders", %{channel: channel} do
    auction = uuid()
    buyer = uuid()
    publish(paid(auction, buyer, ~U[2026-10-10 12:00:00Z]))

    assert {:ok, %V1.EventAchievements{fixed: true, achievements: set}} =
             event_set(channel, auction)

    assert Enum.map(set, & &1.achievement.code) == ~w(first_buyer buyer two_lots thanks mid)
    assert Enum.find(set, &(&1.achievement.code == "first_buyer")).holder_identity_ids == [buyer]
    assert Enum.find(set, &(&1.achievement.code == "thanks")).holder_identity_ids == []
  end

  test "an event no rule has read yet answers the set it would have now, unfixed", %{
    channel: channel
  } do
    assert {:ok, %V1.EventAchievements{fixed: false, achievements: set}} =
             event_set(channel, uuid())

    assert Enum.map(set, & &1.achievement.code) == ~w(first_buyer buyer two_lots thanks mid)
    assert Enum.all?(set, &(&1.holder_identity_ids == []))
  end

  test "the image of an achievement is read by its code", %{channel: channel} do
    assert {:ok,
            %V1.AchievementImage{content: "png bytes", media_type: "image/png", version: version}} =
             V1.AchievementsService.Stub.get_achievement_image(
               channel,
               %V1.GetAchievementImageRequest{achievement_code: "buyer"},
               metadata: auth(@hub_token)
             )

    assert version != ""

    assert {:error, %GRPC.RPCError{status: status}} =
             V1.AchievementsService.Stub.get_achievement_image(
               channel,
               %V1.GetAchievementImageRequest{achievement_code: "thanks"},
               metadata: auth(@hub_token)
             )

    assert status == GRPC.Status.not_found()
  end

  test "a read without a caller token is refused unauthenticated and recorded as a missing token",
       %{channel: channel} do
    log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert {:error, %GRPC.RPCError{status: status}} =
                 V1.AchievementsService.Stub.list_my_achievements(
                   channel,
                   %V1.ListMyAchievementsRequest{identity_id: uuid()}
                 )

        assert status == GRPC.Status.unauthenticated()
      end)

    assert log =~ "caller_refusal=missing_token"
    assert log =~ "error_category=authorization"
  end

  test "a non-canonical identity is refused as an invalid argument", %{channel: channel} do
    assert {:error, %GRPC.RPCError{status: status}} =
             V1.AchievementsService.Stub.list_my_achievements(
               channel,
               %V1.ListMyAchievementsRequest{identity_id: "nobody"},
               metadata: auth(@hub_token)
             )

    assert status == GRPC.Status.invalid_argument()
  end

  defp definitions(image_dir) do
    for {code, recipients, issue, starts_at, rule} <- @definitions do
      %Definition{
        code: code,
        title: "Title #{code}",
        description: "Description #{code}",
        recipients: recipients,
        issue: issue,
        event_kind: :auction,
        starts_at: starts_at,
        rule: rule,
        image: if(code == "buyer", do: Path.join(image_dir, "buyer.png"))
      }
    end
  end

  defp paid(auction, winner, occurred_at) do
    %InvoiceEvent{
      event_id: uuid(),
      invoice_id: uuid(),
      version: 2,
      occurred_at: DateTime.to_iso8601(occurred_at),
      state: %InvoiceState{auction_id: auction, lot_id: uuid(), winner_id: winner},
      occasion: {:invoice_paid, %InvoicePaid{}}
    }
  end

  defp publish(fact), do: publish_all([fact])

  # Без Nats-Msg-Id: повтор того же факта приходит в стрим новым номером, как
  # повторная публикация модуля за окном дедупликации.
  defp publish_all(facts) do
    seq =
      facts
      |> Enum.map(&publish_raw("events.auction.invoice_paid", InvoiceEvent.encode(&1), false))
      |> List.last()

    wait_for_actors(seq)
    seq
  end

  defp publish_raw(subject, payload, wait? \\ true) do
    {:ok, %{body: body}} = Gnat.request(:gnat, subject, payload)
    %{"seq" => seq} = JSON.decode!(body)
    if wait?, do: wait_for_actors(seq)
    seq
  end

  # Актор «late» стартует с будущей даты и стрима не читает: ждём остальных.
  defp wait_for_actors(seq) do
    wait_until(
      fn -> Enum.all?(@rule_codes -- ["late"], &(cursor(&1) >= seq)) end,
      "actors did not reach stream sequence #{seq}"
    )
  end

  defp cursor(code), do: Achievements.Ledger.cursor(code, "AUCTION_EVENTS") || 0

  defp restarted?(code, old) do
    Enum.any?(Supervisor.which_children(Achievements.Actors), fn
      {{Achievements.Actor, ^code}, pid, _, _} -> is_pid(pid) and pid != old
      _ -> false
    end)
  end

  defp holders(auction, code) do
    from(g in "grant",
      where: g.event_key == ^auction and g.achievement_code == ^code and g.state == "live",
      order_by: g.granted_at,
      select: type(g.identity_id, Ecto.UUID)
    )
    |> Repo.all()
  end

  defp members(auction) do
    from(m in "event_set_member",
      where: m.event_key == ^auction,
      order_by: m.achievement_code,
      select: m.achievement_code
    )
    |> Repo.all()
  end

  defp outbox_facts(identity_id) do
    Repo.all(Outbox)
    |> Enum.map(&V1.AchievementGrantEvent.decode(&1.payload))
    |> Enum.filter(&(&1.state.grant.identity_id == identity_id))
  end

  defp event_set(channel, auction) do
    V1.AchievementsService.Stub.get_event_achievements(
      channel,
      %V1.GetEventAchievementsRequest{event: %V1.EventRef{kind: {:auction_id, auction}}},
      metadata: auth(@auction_token)
    )
  end

  defp auth(token), do: %{"authorization" => "Bearer " <> token}

  defp uuid, do: Achievements.UUID7.generate()

  defp wait_until(check, message, attempts \\ 100) do
    cond do
      check.() -> :ok
      attempts == 0 -> flunk(message)
      true -> Process.sleep(100) && wait_until(check, message, attempts - 1)
    end
  end
end
