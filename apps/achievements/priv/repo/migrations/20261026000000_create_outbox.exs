defmodule Achievements.Repo.Migrations.CreateOutbox do
  use Ecto.Migration

  # Очередь фактов Achievements для шины. Строку пишет та же транзакция, что
  # меняет состояние (ADR-077, п. 3), релей переносит её в JetStream. Тело —
  # уже закодированный Protobuf контракта: схемы релей не знает, её приносит
  # контракт сервиса.
  def change do
    create table(:outbox, primary_key: false) do
      add :event_id, :uuid, primary_key: true
      # Порядок публикации: номер выдаётся при вставке.
      add :position, :bigint, null: false, generated: "ALWAYS AS IDENTITY"
      add :subject, :text, null: false
      add :payload, :binary, null: false
      add :occurred_at, :utc_datetime_usec, null: false, default: fragment("now()")
      add :published_at, :utc_datetime_usec
    end

    create unique_index(:outbox, [:position])
    create index(:outbox, [:position], where: "published_at IS NULL", name: :outbox_unpublished)
  end
end
