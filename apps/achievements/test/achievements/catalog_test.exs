defmodule Achievements.CatalogTest do
  use ExUnit.Case, async: true

  alias Achievements.{Catalog, Definition}

  @moduletag :tmp_dir

  test "a valid catalog keeps the order of the definitions", %{tmp_dir: dir} do
    assert {:ok, entries} = Catalog.build([definition("b"), definition("a")], dir)
    assert Enum.map(entries, & &1.definition.code) == ["b", "a"]
  end

  test "an image is loaded with its media type and a version of its bytes", %{tmp_dir: dir} do
    File.write!(Path.join(dir, "badge.png"), "bytes")
    assert {:ok, [entry]} = Catalog.build([definition("a", image: "badge.png")], dir)

    assert entry.image.content == "bytes"
    assert entry.image.media_type == "image/png"

    assert entry.image.version ==
             binary_part(Base.encode16(:crypto.hash(:sha256, "bytes"), case: :lower), 0, 16)
  end

  test "a missing image file refuses the catalog", %{tmp_dir: dir} do
    assert {:error, reason} = Catalog.build([definition("a", image: "absent.png")], dir)
    assert reason =~ "a has no image file"
  end

  test "an image of an unknown type refuses the catalog", %{tmp_dir: dir} do
    File.write!(Path.join(dir, "badge.bmp"), "bytes")
    assert {:error, reason} = Catalog.build([definition("a", image: "badge.bmp")], dir)
    assert reason =~ "unknown type"
  end

  test "a code defined twice refuses the catalog", %{tmp_dir: dir} do
    assert {:error, reason} = Catalog.build([definition("a"), definition("a")], dir)
    assert reason =~ "more than once"
  end

  test "a code that is not snake_case refuses the catalog", %{tmp_dir: dir} do
    assert {:error, reason} = Catalog.build([definition("First-Lot")], dir)
    assert reason =~ "snake_case"
  end

  test "a manual achievement with a rule refuses the catalog", %{tmp_dir: dir} do
    assert {:error, reason} =
             Catalog.build(
               [definition("a", issue: :manual, rule: Achievements.Test.Rules.Payer)],
               dir
             )

    assert reason =~ "has a rule"
  end

  test "a rule achievement without a rule module refuses the catalog", %{tmp_dir: dir} do
    assert {:error, reason} = Catalog.build([definition("a", rule: String)], dir)
    assert reason =~ "Achievements.Rule"
  end

  test "a rule for a meetup refuses the catalog: no meetup stream is read", %{tmp_dir: dir} do
    assert {:error, reason} = Catalog.build([definition("a", event_kind: :meetup)], dir)
    assert reason =~ "no stream"
  end

  test "a manual meetup achievement is valid", %{tmp_dir: dir} do
    assert {:ok, [_]} =
             Catalog.build([definition("a", event_kind: :meetup, issue: :manual, rule: nil)], dir)
  end

  test "load refuses the start of a node with an invalid catalog", %{tmp_dir: dir} do
    assert_raise ArgumentError, ~r/more than once/, fn ->
      Catalog.load!([definition("a"), definition("a")], dir)
    end
  end

  defp definition(code, overrides \\ []) do
    struct!(
      %Definition{
        code: code,
        title: "Title",
        description: "Description",
        recipients: :many,
        issue: :rule,
        event_kind: :auction,
        starts_at: ~U[2026-10-01 00:00:00Z],
        rule: Achievements.Test.Rules.Payer
      },
      overrides
    )
  end
end
