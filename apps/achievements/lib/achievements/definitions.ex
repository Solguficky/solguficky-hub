defmodule Achievements.Definitions do
  @moduledoc """
  Определения ачивок поставки. Новая ачивка — определение здесь и, если у неё
  правило, модуль `Achievements.Rule` рядом; картинка — файл в
  `priv/achievements`, который собирает `just achievements-images` из шаблона и
  знака в `apps/achievements/images` (ADR-077, п. 2). Первый набор аукциона —
  docs/product/future/achievements-auction.md (PER-575), критерии — PER-576.

  Определение, вошедшее хоть в один набор, не удаляется и не меняет код: узел
  с набором, чей код пропал из поставки, не стартует.

  Конфигурация `:definitions` подменяет список: так тесты поднимают узел со
  своими определениями.
  """

  alias Achievements.{Definition, Rules}

  # Дата начала действия первого набора — позже торгов, розыгрыша и итогов
  # прогнозов аукциона 2026: набор, поставленный после аукциона, к нему сам не
  # применяется, пересчёт прошедшего аукциона — явная задача
  # (achievements-auction.md, «Общие правила»). Оплаты 2026 года после этой
  # даты ещё придут: первая из них зафиксирует набор аукциона 2026, а
  # Коллекционер посчитает оплаты от нуля; ачивок за ход торгов там не будет —
  # начала его торгов правило не видело.
  @auction_set_starts_at ~U[2026-11-07 00:00:00Z]

  @delivery [
    %Definition{
      code: "auction_first_bid",
      title: "Первая ставка",
      description: "Первая ставка аукциона — твоя.",
      rarity: :common,
      reach: :one_per_event,
      image: "auction_first_bid.png",
      recipients: :one,
      issue: :rule,
      event_kind: :auction,
      starts_at: @auction_set_starts_at,
      rule: Rules.FirstBid
    },
    %Definition{
      code: "auction_proxy_strategist",
      title: "Прокси-стратег",
      description: "Лот твой, и все ставки на нём за тебя сделала автоставка.",
      rarity: :rare,
      reach: :many,
      image: "auction_proxy_strategist.png",
      recipients: :many,
      issue: :rule,
      event_kind: :auction,
      starts_at: @auction_set_starts_at,
      rule: Rules.ProxyStrategist
    },
    %Definition{
      code: "auction_comeback",
      title: "Камбэк",
      description: "Тебя перебили, а лот всё равно твой.",
      rarity: :epic,
      reach: :few,
      image: "auction_comeback.png",
      recipients: :many,
      issue: :rule,
      event_kind: :auction,
      starts_at: @auction_set_starts_at,
      rule: Rules.Comeback
    },
    %Definition{
      code: "auction_collector",
      title: "Коллекционер",
      description: "Три лота одного аукциона — твои, и все оплачены.",
      rarity: :rare,
      reach: :few,
      image: "auction_collector.png",
      recipients: :many,
      issue: :rule,
      event_kind: :auction,
      starts_at: @auction_set_starts_at,
      rule: Rules.Collector
    },
    %Definition{
      code: "auction_lucky",
      title: "Везунчик",
      description: "Твой билет выпал в розыгрыше.",
      rarity: :common,
      reach: :one_per_event,
      image: "auction_lucky.png",
      recipients: :one,
      issue: :rule,
      event_kind: :auction,
      starts_at: @auction_set_starts_at,
      rule: Rules.Lucky
    },
    %Definition{
      code: "auction_prophet",
      title: "Пророк",
      description: "Твой прогноз сбылся.",
      rarity: :rare,
      reach: :few,
      image: "auction_prophet.png",
      recipients: :many,
      issue: :rule,
      event_kind: :auction,
      starts_at: @auction_set_starts_at,
      rule: Rules.Prophet
    }
  ]

  @doc "Определения поставки, если конфигурация не подменила их."
  @spec all() :: [Definition.t()]
  def all, do: Application.get_env(:achievements, :definitions, @delivery)

  @doc "Определения поставки без подмены конфигурацией."
  @spec delivery() :: [Definition.t()]
  def delivery, do: @delivery
end
