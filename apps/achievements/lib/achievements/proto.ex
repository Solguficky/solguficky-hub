defmodule Achievements.Proto do
  @moduledoc """
  Отображение доменных значений в сообщения `achievements.v1` и обратно — для
  gRPC-ответов и факта выдачи. Структуры контракта собираются только здесь.
  """

  alias Achievements.Catalog.Entry
  alias Achievements.V1

  @doc "Определение каталога как `Achievement` контракта."
  @spec achievement(Entry.t()) :: V1.Achievement.t()
  def achievement(%Entry{definition: d, image: image}) do
    %V1.Achievement{
      code: d.code,
      title: d.title,
      description: d.description,
      rarity: rarity(d.rarity),
      image: image && %V1.AchievementImageRef{version: image.version},
      recipients: recipients(d.recipients),
      issue_method: issue_method(d.issue)
    }
  end

  @doc "Строка реестра как `Grant` контракта."
  @spec grant(map()) :: V1.Grant.t()
  def grant(row) do
    %V1.Grant{
      id: row.id,
      event: event_ref({row.event_kind, row.event_key}),
      achievement_code: row.achievement_code,
      identity_id: row.identity_id,
      granted_at: instant(row.granted_at),
      method: method(row.method)
    }
  end

  @doc "Факт о новой выдаче для outbox: снимок выдачи, определения и повода."
  @spec grant_event(String.t(), map(), Entry.t()) :: V1.AchievementGrantEvent.t()
  def grant_event(event_id, row, entry) do
    %V1.AchievementGrantEvent{
      event_id: event_id,
      achievement_grant_id: row.id,
      version: 1,
      occurred_at: instant(row.granted_at),
      state: %V1.AchievementGrantState{
        grant: grant(row),
        achievement: achievement(entry),
        cause_id: row.cause_id
      },
      occasion: {:achievement_granted, %V1.AchievementGranted{}}
    }
  end

  @spec event_ref({String.t() | atom(), String.t()}) :: V1.EventRef.t()
  def event_ref({kind, key}) when kind in [:auction, "auction"],
    do: %V1.EventRef{kind: {:auction_id, key}}

  def event_ref({kind, key}) when kind in [:meetup, "meetup"],
    do: %V1.EventRef{kind: {:meetup_id, key}}

  @doc "Событие из `EventRef` запроса; пустая или неканоническая ссылка — отказ."
  @spec event(V1.EventRef.t() | nil) :: {:ok, {:auction | :meetup, String.t()}} | :error
  def event(%V1.EventRef{kind: {:auction_id, id}}), do: canonical(:auction, id)
  def event(%V1.EventRef{kind: {:meetup_id, id}}), do: canonical(:meetup, id)
  def event(_), do: :error

  @doc "Каноническая строчная форма UUID с дефисами или отказ."
  @spec uuid(term()) :: {:ok, String.t()} | :error
  def uuid(value) when is_binary(value) do
    case Ecto.UUID.cast(value) do
      {:ok, ^value} -> {:ok, value}
      _ -> :error
    end
  end

  def uuid(_), do: :error

  defp canonical(kind, id) do
    case uuid(id) do
      {:ok, id} -> {:ok, {kind, id}}
      :error -> :error
    end
  end

  # RFC 3339 в UTC, как пишут остальные сервисы.
  defp instant(%DateTime{} = at),
    do: at |> DateTime.shift_zone!("Etc/UTC") |> DateTime.to_iso8601()

  defp rarity(:unspecified), do: :RARITY_UNSPECIFIED

  defp recipients(:one), do: :RECIPIENTS_ONE
  defp recipients(:many), do: :RECIPIENTS_MANY

  defp issue_method(:rule), do: :ISSUE_METHOD_RULE
  defp issue_method(:manual), do: :ISSUE_METHOD_MANUAL

  defp method("rule"), do: :GRANT_METHOD_RULE
  defp method("organizer"), do: :GRANT_METHOD_ORGANIZER
  defp method("maintainer_correction"), do: :GRANT_METHOD_MAINTAINER_CORRECTION
end
