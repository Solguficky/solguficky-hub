defmodule Achievements.Ledger do
  @moduledoc """
  Запись реестра выдач: одна транзакция PostgreSQL на факт стрима для одной
  ачивки (ADR-077, п. 3 и 6, дополнение 2026-10-26).

  В транзакции — позиция чтения стрима, строка дедупликации (ачивка,
  `event_id`), фиксация и пополнение набора события, состояние правила, выдачи
  и строка outbox на каждую выдачу. При откате не остаётся ничего, и повтор
  того же сообщения считается заново; после commit повтор отсекает позиция, а
  тот же факт под новым номером стрима — строка дедупликации.

  Отказ базы — значение `{:error, reason}`: актор пишет его записью и повторяет
  сообщение. Модуль не логирует.
  """

  import Ecto.Query

  alias Achievements.{AuctionFacts, Catalog, Definition, Fact, Outbox, Proto, Repo, UUID7}

  @granted_subject "events.achievements.achievement_granted"

  @type outcome ::
          :duplicate
          | :ignored
          | :before_start
          | :seen
          | {:undecodable, String.t()}
          | {:granted, [map()]}

  @doc "Последний обработанный номер стрима ачивки или `nil`."
  @spec cursor(String.t(), String.t()) :: non_neg_integer() | nil
  def cursor(code, stream) do
    from(c in "stream_cursor",
      where: c.achievement_code == ^code and c.stream == ^stream,
      select: c.stream_seq
    )
    |> Repo.one()
  end

  @doc "Забывает позицию ачивки в стриме: следующее чтение начнётся с даты начала."
  @spec reset_cursor(String.t(), String.t()) :: :ok
  def reset_cursor(code, stream) do
    from(c in "stream_cursor", where: c.achievement_code == ^code and c.stream == ^stream)
    |> Repo.delete_all()

    :ok
  end

  @doc """
  Обрабатывает сообщение стрима `stream` под номером `seq` для ачивки
  `definition`. Исход:

  - `:duplicate` — номер не дальше позиции: сообщение уже обработано;
  - `:ignored` — повод, который правила не читают, или вид, которого не читает
    это правило;
  - `:before_start` — факт раньше даты начала ачивки;
  - `:seen` — `event_id` уже обработан этой ачивкой под другим номером;
  - `{:undecodable, reason}` — тело не разбирается; позиция всё равно
    сдвигается, иначе одно битое сообщение навсегда остановило бы ачивку;
  - `{:granted, rows}` — факт прочитан правилом; `rows` — новые выдачи,
    возможно ни одной.

  Отказ — транзакция откатывается целиком, и сообщение повторяется:

  - `{:error, :unavailable, reason}` — отказ базы;
  - `{:error, :rule, reason}` — правило бросило исключение или назвало
    получателя не каноническим UUID. Это дефект правила, а не тела: позиция
    стоит, пока поставка его не исправит, а соседние ачивки читают дальше.
  """
  @spec apply(Definition.t(), String.t(), pos_integer(), String.t(), binary(), DateTime.t()) ::
          {:ok, outcome()} | {:error, :unavailable | :rule, String.t()}
  def apply(%Definition{} = definition, stream, seq, subject, payload, now \\ DateTime.utc_now()) do
    Repo.transaction(fn ->
      case lock_cursor(definition.code, stream) do
        position when is_integer(position) and seq <= position ->
          :duplicate

        position ->
          outcome = handle(definition, AuctionFacts.decode(subject, payload), now)
          put_cursor(definition.code, stream, seq, position)
          outcome
      end
    end)
    |> case do
      {:ok, outcome} -> {:ok, outcome}
      {:error, {:rule, reason}} -> {:error, :rule, reason}
    end
  rescue
    error in [DBConnection.ConnectionError, Postgrex.Error] ->
      {:error, :unavailable, Exception.message(error)}
  end

  defp handle(_definition, :ignored, _now), do: :ignored
  defp handle(_definition, {:error, reason}, _now), do: {:undecodable, reason}

  defp handle(%Definition{rule: rule} = definition, {:ok, %Fact{} = fact}, now) do
    case reads?(rule, fact) do
      {:ok, false} -> :ignored
      {:ok, true} -> read(definition, fact, now)
      {:error, reason} -> Repo.rollback({:rule, reason})
    end
  end

  defp read(%Definition{rule: rule} = definition, fact, now) do
    cond do
      DateTime.compare(fact.occurred_at, definition.starts_at) == :lt ->
        :before_start

      not first_time?(definition.code, fact.event_id, now) ->
        :seen

      true ->
        join_set(definition, fact, now)

        with {:ok, keys} <- state_keys(rule, fact),
             {:ok, recipients, states} <-
               evaluate(rule, fact, load_states(definition.code, keys)) do
          save_states(definition.code, states)
          {:granted, grant_all(definition, fact, Enum.uniq(recipients), now)}
        else
          {:error, reason} -> Repo.rollback({:rule, reason})
        end
    end
  end

  # Исключение правила повторится на том же факте при каждой доставке: падение
  # актора на нём за секунды исчерпало бы рестарты супервизора и погасило узел
  # вместе с gRPC (норматив, «Процессы и супервизия»). Поэтому каждый вызов
  # правила идёт через rule_call/1, его ответ проверяется до записи в базу, и
  # любой отказ правила — значение, а запись о нём пишет актор. Правило — чистые
  # функции: базы и шины внутри rescue нет, их отказы сюда не попадают.
  defp reads?(rule, fact) do
    rule_call(fn ->
      case rule.reads() do
        kinds when is_list(kinds) -> {:ok, fact.kind in kinds}
        _ -> {:error, "the rule reads no list of fact kinds"}
      end
    end)
  end

  defp state_keys(rule, fact) do
    rule_call(fn ->
      case rule.state_keys(fact) do
        keys when is_list(keys) ->
          if Enum.all?(keys, &is_binary/1),
            do: {:ok, keys},
            else: {:error, "the rule named a state key that is not a string"}

        _ ->
          {:error, "the rule named no list of state keys"}
      end
    end)
  end

  defp evaluate(rule, fact, states) do
    rule_call(fn ->
      with {recipients, new_states} when is_list(recipients) and is_map(new_states) <-
             rule.evaluate(fact, states),
           :ok <- canonical(recipients),
           :ok <- storable(new_states) do
        {:ok, recipients, new_states}
      else
        {:error, reason} -> {:error, reason}
        _ -> {:error, "the rule answered no recipients and states"}
      end
    end)
  end

  defp canonical(recipients) do
    if Enum.all?(recipients, &match?({:ok, _}, Proto.uuid(&1))),
      do: :ok,
      else: {:error, "the rule named a recipient that is not a canonical UUID"}
  end

  # Состояние ложится в jsonb: то, что не кодируется в JSON, отказало бы в
  # Postgrex исключением, которое не отличить от отказа базы.
  defp storable(states) do
    cond do
      not Enum.all?(states, fn {key, state} -> is_binary(key) and is_map(state) end) ->
        {:error, "the rule answered a state that is not a map under a string key"}

      match?({:error, _}, Jason.encode(states)) ->
        {:error, "the rule answered a state that does not encode as JSON"}

      true ->
        :ok
    end
  end

  defp rule_call(call) do
    call.()
  rescue
    error -> {:error, Exception.message(error)}
  catch
    kind, reason -> {:error, "the rule failed with #{kind}: #{inspect(reason)}"}
  end

  defp lock_cursor(code, stream) do
    from(c in "stream_cursor",
      where: c.achievement_code == ^code and c.stream == ^stream,
      select: c.stream_seq,
      lock: "FOR UPDATE"
    )
    |> Repo.one()
  end

  defp put_cursor(code, stream, seq, nil),
    do:
      Repo.insert_all("stream_cursor", [
        %{achievement_code: code, stream: stream, stream_seq: seq}
      ])

  defp put_cursor(code, stream, seq, _position) do
    from(c in "stream_cursor", where: c.achievement_code == ^code and c.stream == ^stream)
    |> Repo.update_all(set: [stream_seq: seq])
  end

  defp first_time?(code, event_id, now) do
    {inserted, _} =
      Repo.insert_all(
        "processed_fact",
        [%{achievement_code: code, event_id: dump_uuid!(event_id), processed_at: now}],
        on_conflict: :nothing
      )

    inserted == 1
  end

  # Первый факт события, который читает правило, фиксирует набор — коды вида
  # с датой начала не позже этого факта. Ачивка, чья дата начала не позже
  # факта, входит и в набор, зафиксированный раньше (дополнение ADR-077, п. 4).
  defp join_set(%Definition{code: code}, %Fact{event: {kind, key}, occurred_at: at}, now) do
    kind = Atom.to_string(kind)

    {fixed, _} =
      Repo.insert_all("event_set", [%{event_kind: kind, event_key: key, fixed_at: now}],
        on_conflict: :nothing
      )

    codes =
      if fixed == 1,
        do: [
          code
          | for(
              entry <- Catalog.started(String.to_existing_atom(kind), at),
              do: entry.definition.code
            )
        ],
        else: [code]

    rows =
      for code <- Enum.uniq(codes),
          do: %{event_kind: kind, event_key: key, achievement_code: code, added_at: now}

    Repo.insert_all("event_set_member", rows, on_conflict: :nothing)
  end

  defp load_states(_code, []), do: %{}

  defp load_states(code, keys) do
    from(s in "rule_state",
      where: s.achievement_code == ^code and s.key in ^keys,
      select: {s.key, s.state}
    )
    |> Repo.all()
    |> Map.new()
    |> then(fn found -> Map.new(keys, &{&1, Map.get(found, &1, %{})}) end)
  end

  defp save_states(_code, states) when map_size(states) == 0, do: :ok

  defp save_states(code, states) do
    rows = for {key, state} <- states, do: %{achievement_code: code, key: key, state: state}

    Repo.insert_all("rule_state", rows,
      on_conflict: {:replace, [:state]},
      conflict_target: [:achievement_code, :key]
    )

    :ok
  end

  # Занятая пара «ачивка набора, субъект» или занятая ачивка с одним
  # получателем — в любом состоянии строки — выдачи не даёт и факта тоже.
  defp grant_all(definition, fact, recipients, now) do
    {:ok, entry} = Catalog.fetch(definition.code)
    {kind, key} = fact.event

    Enum.flat_map(recipients, fn identity_id ->
      case insert_grant(definition, kind, key, identity_id, fact, now) do
        nil ->
          []

        row ->
          event_id = UUID7.generate(now)

          payload =
            Proto.grant_event(event_id, row, entry)
            |> Achievements.V1.AchievementGrantEvent.encode()

          Repo.insert!(%Outbox{event_id: event_id, subject: @granted_subject, payload: payload})
          [row]
      end
    end)
  end

  defp insert_grant(definition, kind, key, identity_id, fact, now) do
    row = %{
      id: UUID7.generate(now),
      event_kind: Atom.to_string(kind),
      event_key: key,
      achievement_code: definition.code,
      identity_id: identity_id,
      single_holder: definition.recipients == :one,
      method: "rule",
      cause_id: fact.event_id,
      granted_at: now
    }

    case Repo.insert_all(
           "grant",
           [
             %{
               row
               | id: dump_uuid!(row.id),
                 identity_id: dump_uuid!(identity_id),
                 cause_id: dump_uuid!(fact.event_id)
             }
           ],
           on_conflict: :nothing
         ) do
      {1, _} -> row
      {0, _} -> nil
    end
  end

  @doc "Гасит выдачу. Погашенная выдача не видна чтениям и не выдаётся заново."
  @spec cancel(String.t(), DateTime.t()) :: :ok | {:error, :not_found}
  def cancel(grant_id, now \\ DateTime.utc_now()) do
    set_state(grant_id, "live", state: "cancelled", cancelled_at: now)
  end

  @doc "Снимает гашение — только мейнтейнер (ADR-077, п. 6)."
  @spec restore(String.t()) :: :ok | {:error, :not_found}
  def restore(grant_id), do: set_state(grant_id, "cancelled", state: "live", cancelled_at: nil)

  defp set_state(grant_id, from, changes) do
    with {:ok, id} <- Ecto.UUID.dump(grant_id),
         {1, _} <-
           from(g in "grant", where: g.id == ^id and g.state == ^from)
           |> Repo.update_all(set: changes) do
      :ok
    else
      _ -> {:error, :not_found}
    end
  end

  defp dump_uuid!(value), do: Ecto.UUID.dump!(value)
end
