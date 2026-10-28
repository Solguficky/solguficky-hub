defmodule Achievements.Definition do
  @moduledoc """
  Определение ачивки — единица кода сервиса (ADR-077, п. 2, дополнение
  2026-10-26, п. 4). Определения поставляются вместе с сервисом и собираются в
  `Achievements.Definitions`; каталог проверяет их при старте узла.

  - `code` — стабильный код, snake_case: на него ссылаются набор, выдача и
    чтение картинки, и вошедшее в набор определение кода не меняет;
  - `rarity` — только оформление; значения контракта приходят с первым набором
    определений (PER-575), до него у перечисления одно `:unspecified`;
  - `image` — файл картинки: путь относительно `priv/achievements` или
    абсолютный; `nil` — картинки нет;
  - `recipients` — `:one` (один держатель на событие) или `:many`;
  - `issue` — `:rule` (выдаёт правило по фактам) или `:manual` (организатор);
  - `event_kind` — вид события, к набору которого ачивка относится;
  - `starts_at` — дата начала действия: актор читает факты не раньше неё, и
    ачивка входит в набор события, чьи факты не раньше неё;
  - `rule` — модуль `Achievements.Rule` у ачивки с правилом.
  """

  @enforce_keys [:code, :title, :description, :recipients, :issue, :event_kind, :starts_at]
  defstruct [
    :code,
    :title,
    :description,
    :recipients,
    :issue,
    :event_kind,
    :starts_at,
    :image,
    :rule,
    rarity: :unspecified
  ]

  @type event_kind :: :auction | :meetup

  @type t :: %__MODULE__{
          code: String.t(),
          title: String.t(),
          description: String.t(),
          rarity: :unspecified,
          image: Path.t() | nil,
          recipients: :one | :many,
          issue: :rule | :manual,
          event_kind: event_kind(),
          starts_at: DateTime.t(),
          rule: module() | nil
        }

  @rarities [:unspecified]

  # Вид события, чей стрим сервис читает. Правило ачивки сходки читать нечего:
  # её набор появляется ручной выдачей (ADR-077, п. 4).
  @rule_kinds [:auction]

  @doc """
  Проверяет определение. Отказ называет код и нарушенное правило: каталог с
  таким определением узел не поднимает.
  """
  @spec validate(t()) :: :ok | {:error, String.t()}
  def validate(%__MODULE__{} = definition) do
    cond do
      not (is_binary(definition.code) and definition.code =~ ~r/^[a-z][a-z0-9_]*$/) ->
        {:error, "achievement code #{inspect(definition.code)} is not lowercase snake_case"}

      not text?(definition.title) or not text?(definition.description) ->
        {:error, "achievement #{definition.code} has an empty title or description"}

      definition.rarity not in @rarities ->
        {:error, "achievement #{definition.code} has an unknown rarity"}

      definition.recipients not in [:one, :many] ->
        {:error, "achievement #{definition.code} has unknown recipients"}

      definition.event_kind not in [:auction, :meetup] ->
        {:error, "achievement #{definition.code} has an unknown event kind"}

      not match?(%DateTime{}, definition.starts_at) ->
        {:error, "achievement #{definition.code} has no start date"}

      true ->
        validate_issue(definition)
    end
  end

  defp validate_issue(%__MODULE__{issue: :manual, rule: nil}), do: :ok

  defp validate_issue(%__MODULE__{issue: :manual} = definition),
    do: {:error, "manual achievement #{definition.code} has a rule"}

  defp validate_issue(%__MODULE__{issue: :rule, rule: rule} = definition) do
    cond do
      definition.event_kind not in @rule_kinds ->
        {:error, "achievement #{definition.code} has a rule but no stream for its event kind"}

      not (is_atom(rule) and Code.ensure_loaded?(rule) and function_exported?(rule, :evaluate, 2)) ->
        {:error, "achievement #{definition.code} names no Achievements.Rule module"}

      true ->
        :ok
    end
  end

  defp validate_issue(definition),
    do: {:error, "achievement #{definition.code} has an unknown issue method"}

  defp text?(value), do: is_binary(value) and String.trim(value) != ""
end
