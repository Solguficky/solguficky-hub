defmodule Achievements.ActorIntegrationTest do
  # L1: акторы ачивок читают AUCTION_EVENTS настоящего NATS и пишут реестр
  # PostgreSQL одной транзакцией на факт; релей выносит факт выдачи.
  use ExUnit.Case, async: false

  @moduletag :integration

  import Ecto.Query
  import Achievements.Test.Node

  alias Achievements.{Maintenance, Outbox, Relay, Repo}
  alias Achievements.Test.Rules
  alias Achievements.V1
  alias Auction.V1.InvoiceEvent
  alias Gnat.Jetstream.API.Stream

  setup_all do
    start!()
    on_exit(&stop/0)
    :ok
  end

  setup do
    Rules.Flaky.fail(false)
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

    assert outbox_codes(buyer) == ~w(buyer first_buyer flaky mid)
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
    refute "buyer" in outbox_codes(buyer)

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

    publish(paid(auction, uuid(), ~U[2026-10-01 12:00:00Z]))
    assert members(auction) == ~w(buyer first_buyer flaky thanks two_lots)

    publish(paid(auction, uuid(), ~U[2026-10-06 12:00:00Z]))
    assert members(auction) == ~w(buyer first_buyer flaky mid thanks two_lots)
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
    wait_for(reading(), seq)

    assert Repo.aggregate(Outbox, :count) == 0
  end

  test "a defective rule holds only its own achievement and grants once it is fixed" do
    auction = uuid()
    buyer = uuid()
    Rules.Flaky.fail(true)

    seq = publish(paid(auction, buyer, ~U[2026-10-10 12:00:00Z]), reading() -- ["flaky"])

    assert holders(auction, "buyer") == [buyer]
    assert holders(auction, "flaky") == []
    assert cursor("flaky") < seq
    assert Process.whereis(Achievements.Actors)

    Rules.Flaky.fail(false)
    wait_for(["flaky"], seq)
    assert holders(auction, "flaky") == [buyer]
  end

  test "an actor restarted by its supervisor resumes after its cursor" do
    auction = uuid()
    buyer = uuid()
    publish(paid(auction, buyer, ~U[2026-10-10 12:00:00Z]))

    old = actor("buyer")
    Process.exit(old, :kill)
    wait_until(fn -> actor("buyer") not in [nil, old] end, "the buyer actor was not restarted")

    other = uuid()
    publish(paid(auction, other, ~U[2026-10-10 12:30:00Z]))

    assert holders(auction, "buyer") |> Enum.sort() == Enum.sort([buyer, other])
    assert length(outbox_codes(buyer)) == 4
  end

  test "the relay publishes each grant as its own fact with the incoming event as its cause" do
    buyer = uuid()
    fact = paid(uuid(), buyer, ~U[2026-10-10 12:00:00Z])
    publish(fact)

    {:ok, _} = Gnat.sub(:gnat, self(), "events.achievements.achievement_granted")
    assert Relay.run_once() == 4

    received =
      for _ <- 1..4 do
        assert_receive {:msg, %{body: body}}, 5_000
        V1.AchievementGrantEvent.decode(body)
      end

    assert Enum.map(received, & &1.state.cause_id) |> Enum.uniq() == [fact.event_id]
    assert Enum.map(received, & &1.state.grant.identity_id) |> Enum.uniq() == [buyer]
    assert Enum.map(received, & &1.achievement_grant_id) |> Enum.uniq() |> length() == 4
  end

  # Порядок тестов случаен, поэтому тест не отпускает стрим, пока каждый
  # читающий актор не выдал ачивку по новой нумерации: иначе прежняя позиция
  # прошла бы ожидание соседнего теста раньше, чем актор заметит пересоздание.
  test "after the stream is recreated every actor resets its position and reads again" do
    :ok = Stream.delete(:gnat, "AUCTION_EVENTS")

    {:ok, _} =
      Stream.create(:gnat, %Stream{name: "AUCTION_EVENTS", subjects: ["events.auction.>"]})

    auction = uuid()
    buyer = uuid()

    for at <- [~U[2026-10-10 12:00:00Z], ~U[2026-10-10 13:00:00Z]] do
      publish_raw("events.auction.invoice_paid", InvoiceEvent.encode(paid(auction, buyer, at)))
    end

    wait_until(
      fn -> Enum.all?(reading(), &(holders(auction, &1) == [buyer])) end,
      "the actors did not read the recreated stream"
    )
  end

  defp actor(code) do
    Enum.find_value(Supervisor.which_children(Achievements.Actors), fn
      {{Achievements.Actor, ^code}, pid, _, _} when is_pid(pid) -> pid
      _ -> nil
    end)
  end

  defp members(auction) do
    from(m in "event_set_member",
      where: m.event_key == ^auction,
      order_by: m.achievement_code,
      select: m.achievement_code
    )
    |> Repo.all()
  end

  defp outbox_codes(identity_id) do
    Repo.all(Outbox)
    |> Enum.map(&V1.AchievementGrantEvent.decode(&1.payload))
    |> Enum.filter(&(&1.state.grant.identity_id == identity_id))
    |> Enum.map(& &1.state.grant.achievement_code)
    |> Enum.sort()
  end
end
