defmodule Achievements.DatabaseUrlTest do
  use ExUnit.Case, async: true

  alias Achievements.DatabaseUrl

  test "sslmode disable turns TLS off and leaves the URL without parameters" do
    options = DatabaseUrl.repo_options("postgres://u:p@db:5432/achievements?sslmode=disable")

    assert options[:url] == "postgres://u:p@db:5432/achievements"
    assert options[:ssl] == false
  end

  test "sslmode require encrypts without verifying the server" do
    assert DatabaseUrl.repo_options("postgres://u:p@db/a?sslmode=require")[:ssl] == [
             verify: :verify_none
           ]
  end

  test "sslmode verify-full verifies the chain and the host name" do
    ssl = DatabaseUrl.repo_options("postgresql://u:p@db.example/a?sslmode=verify-full")[:ssl]

    assert ssl[:verify] == :verify_peer
    assert ssl[:server_name_indication] == ~c"db.example"
  end

  test "sslmode verify-ca verifies the chain but not the host name" do
    ssl = DatabaseUrl.repo_options("postgres://u:p@db/a?sslmode=verify-ca")[:ssl]

    assert ssl[:verify] == :verify_peer
    assert ssl[:server_name_indication] == :disable
  end

  test "an unknown connection parameter fails instead of being ignored" do
    assert_raise ArgumentError, ~r/connect_timeout/, fn ->
      DatabaseUrl.repo_options("postgres://u:p@db/a?connect_timeout=5")
    end
  end

  test "a URI of another scheme is rejected without echoing it" do
    error =
      assert_raise ArgumentError, fn -> DatabaseUrl.repo_options("mysql://u:secret@db/a") end

    refute error.message =~ "secret"
  end
end
