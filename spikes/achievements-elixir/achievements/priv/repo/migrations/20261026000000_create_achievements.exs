defmodule Achievements.Repo.Migrations.CreateAchievements do
  use Ecto.Migration

  def change do
    create table(:processed, primary_key: false) do
      add :achievement, :text, primary_key: true
      add :event_id, :text, primary_key: true
    end

    create table(:rule_state, primary_key: false) do
      add :achievement, :text, primary_key: true
      add :subject, :text, primary_key: true
      add :count, :integer, null: false
    end

    create table(:grants) do
      add :achievement, :text, null: false
      add :subject, :text, null: false
      add :single, :boolean, null: false
      add :occasion_event, :text, null: false
      add :seq, :bigint, null: false
    end

    create unique_index(:grants, [:achievement, :subject])
    # Ачивка с одним получателем держит не больше одной строки (ADR-077 п.6).
    create unique_index(:grants, [:achievement], where: "single", name: :grants_single_index)

    create table(:outbox) do
      add :occasion_event, :text, null: false
      add :seq, :bigint, null: false
      add :achievement, :text, null: false
      add :subject, :text, null: false
      add :published_at, :utc_datetime_usec
    end

    create table(:cursors, primary_key: false) do
      add :achievement, :text, primary_key: true
      add :seq, :bigint, null: false
    end
  end
end
