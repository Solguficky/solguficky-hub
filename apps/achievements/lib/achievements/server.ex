defmodule Achievements.Server do
  @moduledoc """
  `achievements.v1.AchievementsService` — чтения обоих ботов (ADR-077, п. 7).
  Неканонический id или пустая ссылка на событие — `INVALID_ARGUMENT`;
  картинки нет — `NOT_FOUND`. Ручная выдача — PER-753, до неё
  `GrantAchievement` отвечает `UNIMPLEMENTED`.
  """
  use GRPC.Server, service: Achievements.V1.AchievementsService.Service

  alias Achievements.{Catalog, Proto, Reads}
  alias Achievements.V1

  def list_my_achievements(%V1.ListMyAchievementsRequest{identity_id: identity_id}, _stream) do
    id = uuid!(identity_id, "identity_id")

    held =
      for {row, entry} <- Reads.collection(id),
          do: %V1.HeldAchievement{grant: Proto.grant(row), achievement: Proto.achievement(entry)}

    %V1.MyAchievements{identity_id: id, achievements: held}
  end

  def get_event_achievements(%V1.GetEventAchievementsRequest{event: ref}, _stream) do
    event =
      case Proto.event(ref) do
        {:ok, event} -> event
        :error -> invalid!("event is not a canonical meetup or auction id")
      end

    set = Reads.event_set(event)

    achievements =
      for {entry, holders} <- set.achievements,
          do: %V1.EventAchievement{
            achievement: Proto.achievement(entry),
            holder_identity_ids: holders
          }

    %V1.EventAchievements{
      event: Proto.event_ref(event),
      fixed: set.fixed,
      achievements: achievements
    }
  end

  def get_achievement_image(%V1.GetAchievementImageRequest{achievement_code: code}, _stream) do
    case Catalog.fetch(code) do
      {:ok, %{image: %{} = image}} ->
        %V1.AchievementImage{
          content: image.content,
          media_type: image.media_type,
          version: image.version
        }

      _ ->
        raise GRPC.RPCError, status: :not_found, message: "no image for this achievement code"
    end
  end

  def grant_achievement(_request, _stream),
    do: raise(GRPC.RPCError, status: :unimplemented, message: "manual grant arrives with PER-753")

  defp uuid!(value, field) do
    case Proto.uuid(value) do
      {:ok, id} -> id
      :error -> invalid!("#{field} is not a canonical UUID")
    end
  end

  defp invalid!(message), do: raise(GRPC.RPCError, status: :invalid_argument, message: message)
end
