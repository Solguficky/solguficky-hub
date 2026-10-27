defmodule Achievements.Outbox do
  @moduledoc "Строка очереди фактов для шины (миграция `create_outbox`)."
  use Ecto.Schema

  @primary_key {:event_id, Ecto.UUID, autogenerate: false}
  schema "outbox" do
    field :position, :integer, read_after_writes: true
    field :subject, :string
    field :payload, :binary
    field :occurred_at, :utc_datetime_usec, read_after_writes: true
    field :published_at, :utc_datetime_usec
  end
end
