defmodule Achievements.Maintenance do
  @moduledoc """
  Техническое действие мейнтейнера над ошибочной выдачей (ADR-077, п. 6). Экрана
  в боте и метода gRPC нет: функции зовутся в работающем узле, например

      bin/achievements rpc 'IO.inspect(Achievements.Maintenance.grants("<identity id>"))'
      bin/achievements rpc 'IO.inspect(Achievements.Maintenance.cancel_grant("<grant id>"))'

  Гашение выдачу не удаляет: строка остаётся и держит пару «ачивка набора,
  субъект», поэтому ни повтор факта, ни новое срабатывание правила её не
  возвращают. Снять гашение может только мейнтейнер — `restore_grant/1`. Ни
  гашение, ни его снятие факта на шину не дают (integration.md, «Achievements
  NATS»). Переназначение ачивки с одним получателем — ручная выдача
  мейнтейнера, PER-753.
  """

  import Ecto.Query

  alias Achievements.{Ledger, Repo}

  @doc "Выдачи человека во всех состояниях — чтобы найти id ошибочной."
  @spec grants(String.t()) :: [map()]
  def grants(identity_id) do
    id = Ecto.UUID.dump!(identity_id)

    from(g in "grant",
      where: g.identity_id == ^id,
      order_by: [g.granted_at, g.id],
      select: %{
        id: type(g.id, Ecto.UUID),
        event_kind: g.event_kind,
        event_key: g.event_key,
        achievement_code: g.achievement_code,
        method: g.method,
        state: g.state,
        granted_at: g.granted_at
      }
    )
    |> Repo.all()
  end

  @doc "Гасит живую выдачу; `{:error, :not_found}` — нет живой выдачи с этим id."
  @spec cancel_grant(String.t()) :: :ok | {:error, :not_found}
  def cancel_grant(grant_id), do: Ledger.cancel(grant_id)

  @doc "Снимает гашение; `{:error, :not_found}` — нет погашенной выдачи с этим id."
  @spec restore_grant(String.t()) :: :ok | {:error, :not_found}
  def restore_grant(grant_id), do: Ledger.restore(grant_id)
end
