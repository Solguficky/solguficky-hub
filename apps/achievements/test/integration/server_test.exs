defmodule Achievements.ServerIntegrationTest do
  # L1: чтения AchievementsService по сети над реестром, который наполняют
  # акторы из настоящего стрима, и проверка вызывающего по токену.
  use ExUnit.Case, async: false

  @moduletag :integration

  import Achievements.Test.Node

  alias Achievements.V1
  alias Achievements.V1.AchievementsService.Stub

  setup_all do
    channel = start!()
    on_exit(&stop/0)
    %{channel: channel}
  end

  test "the own collection lists live grants with their definitions", %{channel: channel} do
    auction = uuid()
    buyer = uuid()
    publish(paid(auction, buyer, ~U[2026-10-10 12:00:00Z]))

    assert {:ok, %V1.MyAchievements{achievements: held}} =
             Stub.list_my_achievements(
               channel,
               %V1.ListMyAchievementsRequest{identity_id: buyer},
               metadata: auth(auction_token())
             )

    assert Enum.map(held, & &1.achievement.code) |> Enum.sort() ==
             ~w(buyer first_buyer flaky mid)

    assert Enum.all?(held, &(&1.grant.event == %V1.EventRef{kind: {:auction_id, auction}}))
    assert Enum.find(held, &(&1.achievement.code == "buyer")).achievement.image.version != ""
  end

  test "a fixed set lists its achievements in catalog order with holders", %{channel: channel} do
    auction = uuid()
    buyer = uuid()
    publish(paid(auction, buyer, ~U[2026-10-10 12:00:00Z]))

    assert {:ok, %V1.EventAchievements{fixed: true, achievements: set}} =
             event_set(channel, auction)

    assert Enum.map(set, & &1.achievement.code) == ~w(first_buyer buyer two_lots thanks mid flaky)
    assert Enum.find(set, &(&1.achievement.code == "first_buyer")).holder_identity_ids == [buyer]
    assert Enum.find(set, &(&1.achievement.code == "thanks")).holder_identity_ids == []
  end

  test "an event no rule has read yet answers the set it would have now, unfixed",
       %{channel: channel} do
    assert {:ok, %V1.EventAchievements{fixed: false, achievements: set}} =
             event_set(channel, uuid())

    assert Enum.map(set, & &1.achievement.code) == ~w(first_buyer buyer two_lots thanks mid flaky)
    assert Enum.all?(set, &(&1.holder_identity_ids == []))
  end

  test "the image of an achievement is read by its code", %{channel: channel} do
    assert {:ok, %V1.AchievementImage{content: "png bytes", media_type: "image/png", version: v}} =
             Stub.get_achievement_image(
               channel,
               %V1.GetAchievementImageRequest{achievement_code: "buyer"},
               metadata: auth(hub_token())
             )

    assert v != ""
  end

  test "an achievement without an image answers not found", %{channel: channel} do
    assert {:error, %GRPC.RPCError{status: status}} =
             Stub.get_achievement_image(
               channel,
               %V1.GetAchievementImageRequest{achievement_code: "thanks"},
               metadata: auth(hub_token())
             )

    assert status == GRPC.Status.not_found()
  end

  test "a read without a caller token is refused unauthenticated and recorded as a missing token",
       %{channel: channel} do
    log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert {:error, %GRPC.RPCError{status: status}} =
                 Stub.list_my_achievements(channel, %V1.ListMyAchievementsRequest{
                   identity_id: uuid()
                 })

        assert status == GRPC.Status.unauthenticated()
      end)

    assert log =~ "caller_refusal=missing_token"
    assert log =~ "error_category=authorization"
  end

  test "the auction bot is refused the manual grant it is not declared for", %{channel: channel} do
    log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert {:error, %GRPC.RPCError{status: status}} =
                 Stub.grant_achievement(channel, %V1.GrantAchievementRequest{},
                   metadata: auth(auction_token())
                 )

        assert status == GRPC.Status.unauthenticated()
      end)

    assert log =~ "caller_refusal=not_declared"
    assert log =~ "caller=auction-bot"
  end

  test "a non-canonical identity is refused as an invalid argument", %{channel: channel} do
    assert {:error, %GRPC.RPCError{status: status}} =
             Stub.list_my_achievements(
               channel,
               %V1.ListMyAchievementsRequest{identity_id: "nobody"},
               metadata: auth(hub_token())
             )

    assert status == GRPC.Status.invalid_argument()
  end

  defp event_set(channel, auction) do
    Stub.get_event_achievements(
      channel,
      %V1.GetEventAchievementsRequest{event: %V1.EventRef{kind: {:auction_id, auction}}},
      metadata: auth(auction_token())
    )
  end
end
