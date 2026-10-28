defmodule Achievements.Reads do
  @moduledoc """
  Чтения реестра для обоих ботов (ADR-077, п. 7). Погашенную выдачу не отдаёт ни
  одно чтение. Определение берётся текущее, из каталога поставки: набор
  фиксирует коды, а не копию определений.
  """

  import Ecto.Query

  alias Achievements.{Catalog, Repo}
  alias Achievements.Catalog.Entry

  @doc "Живые выдачи человека по всем событиям, раньше выданное первым."
  @spec collection(String.t()) :: [{map(), Entry.t()}]
  def collection(identity_id) do
    id = Ecto.UUID.dump!(identity_id)

    from(g in "grant",
      where: g.identity_id == ^id and g.state == "live",
      order_by: [g.granted_at, g.id],
      select: ^grant_fields()
    )
    |> Repo.all()
    |> Enum.flat_map(fn row ->
      case Catalog.fetch(row.achievement_code) do
        {:ok, entry} -> [{load(row), entry}]
        :error -> []
      end
    end)
  end

  @doc """
  Набор события: зафиксированный — его коды в порядке каталога с держателями;
  ещё не зафиксированный — определения вида, из которых он сложился бы сейчас,
  без держателей.
  """
  @spec event_set({:auction | :meetup, String.t()}, DateTime.t()) ::
          %{fixed: boolean(), achievements: [{Entry.t(), [String.t()]}]}
  def event_set({kind, key}, now \\ DateTime.utc_now()) do
    kind_text = Atom.to_string(kind)

    if fixed?(kind_text, key) do
      codes = MapSet.new(members(kind_text, key))
      holders = holders(kind_text, key)

      achievements =
        for %Entry{definition: d} = entry <- Catalog.entries(),
            MapSet.member?(codes, d.code),
            do: {entry, Map.get(holders, d.code, [])}

      %{fixed: true, achievements: achievements}
    else
      %{fixed: false, achievements: for(entry <- Catalog.started(kind, now), do: {entry, []})}
    end
  end

  @doc "Коды всех зафиксированных наборов: каждый обязан найтись в каталоге."
  @spec set_codes() :: [String.t()]
  def set_codes,
    do: from(m in "event_set_member", distinct: true, select: m.achievement_code) |> Repo.all()

  defp fixed?(kind, key),
    do: Repo.exists?(from s in "event_set", where: s.event_kind == ^kind and s.event_key == ^key)

  defp members(kind, key) do
    from(m in "event_set_member",
      where: m.event_kind == ^kind and m.event_key == ^key,
      select: m.achievement_code
    )
    |> Repo.all()
  end

  defp holders(kind, key) do
    from(g in "grant",
      where: g.event_kind == ^kind and g.event_key == ^key and g.state == "live",
      order_by: [g.granted_at, g.id],
      select: {g.achievement_code, g.identity_id}
    )
    |> Repo.all()
    |> Enum.group_by(&elem(&1, 0), &Ecto.UUID.load!(elem(&1, 1)))
  end

  defp grant_fields,
    do: [
      :id,
      :event_kind,
      :event_key,
      :achievement_code,
      :identity_id,
      :method,
      :cause_id,
      :granted_at
    ]

  defp load(row) do
    %{
      row
      | id: Ecto.UUID.load!(row.id),
        identity_id: Ecto.UUID.load!(row.identity_id),
        cause_id: Ecto.UUID.load!(row.cause_id),
        # Колонка без зоны хранит UTC; запрос без схемы читает её наивной.
        granted_at: DateTime.from_naive!(row.granted_at, "Etc/UTC")
    }
  end
end
