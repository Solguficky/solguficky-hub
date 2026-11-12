defmodule Achievements.Grpc.CallersTest do
  use ExUnit.Case, async: true

  alias Achievements.Grpc.Callers

  @callers %{hub_bot: "hub-token", auction_bot: "auction-token"}
  @read "/achievements.v1.AchievementsService/ListMyAchievements"
  @grant "/achievements.v1.AchievementsService/GrantAchievement"

  test "a declared caller with its token is admitted and named" do
    assert Callers.admit(@read, bearer("auction-token"), @callers) == {:ok, :auction_bot}
    assert Callers.admit(@grant, bearer("hub-token"), @callers) == {:ok, :hub_bot}
  end

  test "a caller is not admitted to a method it is not declared for" do
    assert Callers.admit(@grant, bearer("auction-token"), @callers) ==
             {:error, :not_declared, :auction_bot}
  end

  test "a call without a token is refused as a missing token" do
    assert Callers.admit(@read, %{}, @callers) == {:error, :missing_token, nil}

    assert Callers.admit(@read, %{"authorization" => "Bearer "}, @callers) ==
             {:error, :missing_token, nil}
  end

  test "an unknown token is refused without naming a caller" do
    assert Callers.admit(@read, bearer("forged"), @callers) == {:error, :unknown_token, nil}
  end

  test "an undeclared method of the service admits nobody" do
    assert {:error, :not_declared, :hub_bot} =
             Callers.admit(
               "/achievements.v1.AchievementsService/Unknown",
               bearer("hub-token"),
               @callers
             )
  end

  test "a caller is named by its AppHost node" do
    assert Callers.node_name(:auction_bot) == "auction-bot"
  end

  defp bearer(token), do: %{"authorization" => "Bearer " <> token}
end
