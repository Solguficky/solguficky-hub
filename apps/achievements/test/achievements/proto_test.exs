defmodule Achievements.ProtoTest do
  use ExUnit.Case, async: true

  alias Achievements.{Definition, Proto, UUID7}
  alias Achievements.Catalog.Entry
  alias Achievements.V1

  @row %{
    id: "0192f5a0-0000-7000-8000-000000000010",
    event_kind: "auction",
    event_key: "5f0c7a3e-3c1d-5a8b-9e1f-2a4b6c8d0e1f",
    achievement_code: "first_buyer",
    identity_id: "0192f5a0-0000-7000-8000-000000000001",
    method: "rule",
    cause_id: "0192f5a0-0000-7000-8000-0000000000aa",
    granted_at: ~U[2026-10-28 12:00:00.000000Z]
  }

  test "a grant fact carries the whole snapshot, its definition and its cause" do
    event = Proto.grant_event("0192f5a0-0000-7000-8000-0000000000ff", @row, entry())

    assert event.event_id == "0192f5a0-0000-7000-8000-0000000000ff"
    assert event.achievement_grant_id == @row.id
    assert event.version == 1
    assert event.occurred_at == "2026-10-28T12:00:00.000000Z"
    assert event.occasion == {:achievement_granted, %V1.AchievementGranted{}}
    assert event.state.cause_id == @row.cause_id
    assert event.state.grant.event == %V1.EventRef{kind: {:auction_id, @row.event_key}}
    assert event.state.grant.method == :GRANT_METHOD_RULE
    assert event.state.achievement.recipients == :RECIPIENTS_ONE
    assert event.state.achievement.image == %V1.AchievementImageRef{version: "abc"}

    assert event |> V1.AchievementGrantEvent.encode() |> V1.AchievementGrantEvent.decode() ==
             event
  end

  test "an achievement without an image carries no image reference" do
    assert Proto.achievement(%{entry() | image: nil}).image == nil
  end

  test "an event reference is read only in its canonical form" do
    id = "5f0c7a3e-3c1d-5a8b-9e1f-2a4b6c8d0e1f"

    assert Proto.event(%V1.EventRef{kind: {:auction_id, id}}) == {:ok, {:auction, id}}
    assert Proto.event(%V1.EventRef{kind: {:meetup_id, id}}) == {:ok, {:meetup, id}}
    assert Proto.event(%V1.EventRef{kind: {:auction_id, String.upcase(id)}}) == :error
    assert Proto.event(%V1.EventRef{}) == :error
    assert Proto.event(nil) == :error
  end

  test "a UUIDv7 carries version 7, the RFC variant and grows with time" do
    early = UUID7.generate(~U[2026-10-01 00:00:00Z])
    late = UUID7.generate(~U[2026-10-02 00:00:00Z])

    assert {:ok, ^early} = Proto.uuid(early)
    assert String.at(early, 14) == "7"
    assert String.at(early, 19) in ["8", "9", "a", "b"]
    assert early < late
  end

  defp entry do
    %Entry{
      definition: %Definition{
        code: "first_buyer",
        title: "First buyer",
        description: "Paid first",
        recipients: :one,
        issue: :rule,
        event_kind: :auction,
        starts_at: ~U[2026-10-01 00:00:00Z],
        rule: Achievements.Test.Rules.Payer
      },
      image: %{content: "bytes", media_type: "image/png", version: "abc"}
    }
  end
end
