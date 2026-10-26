defmodule Achievements.Relay do
  @moduledoc """
  Релей outbox по предложению к ADR-077 п.8: повод уходит одним фактом, когда
  водяной знак — наименьший курсор ачивок стрима — его прошёл. Публикацию в
  шину спайк не делает: контракта achievements нет, отдаётся список поводов.
  """
  import Ecto.Query
  alias Achievements.Repo

  def run_once(codes) do
    watermark = Repo.one(from c in "cursors", where: c.achievement in ^codes, select: min(c.seq)) || 0

    Repo.transaction(fn ->
      # Один релей за раз: FOR UPDATE с GROUP BY PostgreSQL не принимает.
      Repo.query!("select pg_advisory_xact_lock(7702)")

      ready =
        from(o in "outbox",
          where: is_nil(o.published_at) and o.seq <= ^watermark,
          group_by: [o.occasion_event, o.seq],
          order_by: o.seq,
          select: {o.occasion_event, o.seq, fragment("array_agg(? || ':' || ? ORDER BY ?)", o.achievement, o.subject, o.achievement)}
        )
        |> Repo.all()

      ids = Enum.map(ready, &elem(&1, 0))
      from(o in "outbox", where: o.occasion_event in ^ids)
      |> Repo.update_all(set: [published_at: DateTime.utc_now()])
      ready
    end)
  end
end
