defmodule Achievements.Repo.Migrations.CreateRegistry do
  use Ecto.Migration

  # Реестр выдач и всё, что пишет одна транзакция факта (ADR-077, п. 3 и 6,
  # дополнение 2026-10-26). Событие — пара вида и ключа: `auction` и id
  # аукциона, `meetup` и id сходки (EventRef контракта).
  def change do
    # Набор события зафиксирован: событие впервые понадобилось правилу.
    create table(:event_set, primary_key: false) do
      add :event_kind, :text, primary_key: true
      add :event_key, :text, primary_key: true
      add :fixed_at, :utc_datetime_usec, null: false
    end

    # Коды набора. Строка только вставляется: набор пополняется ачивкой, чья
    # дата начала не позже его фактов, и никогда не теряет код.
    create table(:event_set_member, primary_key: false) do
      add :event_kind, :text, primary_key: true
      add :event_key, :text, primary_key: true
      add :achievement_code, :text, primary_key: true
      add :added_at, :utc_datetime_usec, null: false
    end

    # Выдача. Уникальности держат строку в любом состоянии — живую и
    # погашенную, — поэтому погашенная выдача не возвращается ни повтором
    # факта, ни новым срабатыванием правила.
    create table(:grant, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :event_kind, :text, null: false
      add :event_key, :text, null: false
      add :achievement_code, :text, null: false
      add :identity_id, :uuid, null: false
      add :single_holder, :boolean, null: false
      # rule | organizer | maintainer_correction
      add :method, :text, null: false

      # Кем выдана: пусто у правила, identity id организатора или мейнтейнер.
      add :granted_by, :text
      add :cause_id, :uuid, null: false
      # live | cancelled
      add :state, :text, null: false, default: "live"
      add :granted_at, :utc_datetime_usec, null: false
      add :cancelled_at, :utc_datetime_usec
    end

    create unique_index(:grant, [:achievement_code, :event_kind, :event_key, :identity_id],
             name: :grant_holder
           )

    # Ачивка с одним получателем держит в наборе события одну строку.
    create unique_index(:grant, [:achievement_code, :event_kind, :event_key],
             name: :grant_single_holder,
             where: "single_holder"
           )

    create index(:grant, [:identity_id, :granted_at], name: :grant_collection)

    # Дедупликация входящих фактов по event_id модуля, своя у каждой ачивки.
    # По сроку не чистится: очищенный ключ вернул бы стёртую и погашенную
    # выдачу при повторной публикации модуля.
    create table(:processed_fact, primary_key: false) do
      add :achievement_code, :text, primary_key: true
      add :event_id, :uuid, primary_key: true
      add :processed_at, :utc_datetime_usec, null: false
    end

    # Состояние правила, которому мало одного факта: только то, что правило
    # считает, по ключу, который оно выбирает.
    create table(:rule_state, primary_key: false) do
      add :achievement_code, :text, primary_key: true
      add :key, :text, primary_key: true
      add :state, :map, null: false
    end

    # Позиция чтения стрима модуля: последний обработанный номер стрима.
    # Источник истины — эта строка в транзакции факта, а не потребитель
    # JetStream: он эфемерный и стартует с позиции + 1.
    create table(:stream_cursor, primary_key: false) do
      add :achievement_code, :text, primary_key: true
      add :stream, :text, primary_key: true
      add :stream_seq, :bigint, null: false
    end
  end
end
