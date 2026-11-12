defmodule Achievements.UUID7Test do
  use ExUnit.Case, async: true

  alias Achievements.UUID7

  test "a UUIDv7 is canonical, carries version 7 and the RFC variant" do
    id = UUID7.generate(~U[2026-10-01 00:00:00Z])

    assert {:ok, ^id} = Ecto.UUID.cast(id)
    assert id == String.downcase(id)
    assert String.at(id, 14) == "7"
    assert String.at(id, 19) in ["8", "9", "a", "b"]
  end

  test "a later UUIDv7 sorts after an earlier one" do
    assert UUID7.generate(~U[2026-10-01 00:00:00Z]) < UUID7.generate(~U[2026-10-02 00:00:00Z])
  end
end
