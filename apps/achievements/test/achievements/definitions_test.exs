defmodule Achievements.DefinitionsTest do
  # async: false — тест читает конфигурацию приложения, которую L1 подменяет.
  use ExUnit.Case, async: false

  alias Achievements.{Catalog, Definitions}

  @images Path.expand("../../priv/achievements", __DIR__)
  @png <<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A>>

  # Первый набор аукциона — docs/product/future/achievements-auction.md.
  @set ~w(auction_first_bid auction_proxy_strategist auction_comeback auction_collector auction_lucky auction_prophet)

  test "the delivery is the first auction set, in its order" do
    assert Enum.map(Definitions.delivery(), & &1.code) == @set
  end

  test "the delivery builds a catalog with its images" do
    assert {:ok, entries} = Catalog.build(Definitions.delivery(), @images)

    for entry <- entries do
      assert entry.image.media_type == "image/png", entry.definition.code
      assert binary_part(entry.image.content, 0, 8) == @png, entry.definition.code
    end
  end

  test "every achievement of the delivery names its rarity and its reach" do
    for d <- Definitions.delivery() do
      assert d.rarity != :unspecified, d.code
      assert d.reach != :unspecified, d.code
    end
  end

  # Рамку и подпись картинки рисует images/ по badges.json: расхождение с
  # определением показало бы ценность или охват, которых у ачивки нет.
  test "the badge of every image agrees with the rarity and reach of its definition" do
    badges =
      Path.expand("../../images/badges.json", __DIR__)
      |> File.read!()
      |> JSON.decode!()
      |> Map.new(&{&1["code"], {&1["rarity"], &1["reach"]}})

    assert Map.keys(badges) |> Enum.sort() == Enum.sort(@set)

    for d <- Definitions.delivery() do
      assert badges[d.code] == {Atom.to_string(d.rarity), Atom.to_string(d.reach)}, d.code
      assert d.image == d.code <> ".png", d.code
    end
  end

  test "the delivery starts after the facts of the auction of 2026" do
    # Аукцион 2026 закончился 31 октября; набор к нему сам не применяется.
    for d <- Definitions.delivery() do
      assert DateTime.compare(d.starts_at, ~U[2026-11-01 00:00:00Z]) == :gt, d.code
    end
  end

  test "without a configured list the node takes the delivery" do
    assert Application.get_env(:achievements, :definitions) == nil
    assert Definitions.all() == Definitions.delivery()
  end
end
