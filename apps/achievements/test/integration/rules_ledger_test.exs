defmodule Achievements.RulesLedgerIntegrationTest do
  # L1: правила поставки через настоящий Ledger над PostgreSQL. Тесты правил
  # идут харнессом без базы (Achievements.Test.RuleRun); здесь доказывается,
  # что Ledger с jsonb-состоянием и уникальностями реестра выдаёт тех же
  # держателей, а повтор стрима под новыми номерами второй выдачи не даёт.
  use ExUnit.Case, async: false

  @moduletag :integration

  import Ecto.Query
  import Achievements.Test.AuctionEvents

  alias Achievements.{Definitions, Ledger, Repo}
  alias Achievements.Test.RuleRun
  alias Testcontainers.PostgresContainer

  @stream "AUCTION_EVENTS"

  setup_all do
    {:ok, _} = Application.ensure_all_started(:testcontainers)

    case Testcontainers.start_link() do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> :ok
    end

    {:ok, postgres} =
      Testcontainers.start_container(
        PostgresContainer.new()
        |> PostgresContainer.with_image("postgres:16-alpine")
      )

    db = PostgresContainer.connection_parameters(postgres)

    # Без адреса шины акторов нет: факты подаёт тест, а каталог — поставка.
    Application.put_env(:achievements, Repo, Keyword.put(db, :ssl, false))
    Application.put_env(:achievements, :grpc_port, Enum.random(40_000..49_999))
    Application.delete_env(:achievements, :nats)
    Application.delete_env(:achievements, :definitions)

    {:ok, _} = Application.ensure_all_started(:achievements)
    on_exit(fn -> Application.stop(:achievements) end)
    :ok
  end

  test "every achievement of the delivery grants through the ledger what the rule run grants" do
    {auction, messages} = scenario()

    for definition <- Definitions.delivery() do
      feed(definition, messages)
      expected = RuleRun.holders(definition, messages)

      assert expected != [], "the scenario grants no #{definition.code}"
      assert Enum.sort(holders(definition.code, auction)) == Enum.sort(expected), definition.code
    end
  end

  test "the whole stream again under new stream numbers gives no second grant" do
    {auction, messages} = scenario()

    for definition <- Definitions.delivery() do
      feed(definition, messages)
      before = holders(definition.code, auction)
      feed(definition, Enum.reverse(messages))

      assert holders(definition.code, auction) == before, definition.code
    end
  end

  # Номера стрима — после позиции ачивки: она общая у тестов модуля, а их
  # порядок случаен.
  defp feed(definition, messages) do
    position = Ledger.cursor(definition.code, @stream) || 0

    messages
    |> Enum.with_index(position + 1)
    |> Enum.each(fn {{subject, body}, seq} ->
      assert {:ok, _} = Ledger.apply(definition, @stream, seq, subject, body)
    end)
  end

  defp holders(code, auction) do
    from(g in "grant",
      where: g.achievement_code == ^code and g.event_key == ^auction,
      select: g.identity_id
    )
    |> Repo.all()
    |> Enum.map(&Ecto.UUID.cast!/1)
  end

  # Один аукцион, в котором есть повод для каждой ачивки набора: камбэк Гоши на
  # первом лоте, прокси-стратегия Вити на втором, третий лот Гоши, розыгрыш и
  # прогнозы. Каждый тест берёт свежий аукцион.
  defp scenario do
    auction = uuid()
    [lot1, lot2, lot3] = lots = [uuid(), uuid(), uuid()]
    [gosha, dasha, vitya] = [uuid(), uuid(), uuid()]
    tickets = [dasha, vitya, gosha]

    answers =
      [{vitya, [{:PREDICTION_NOMINATION_TOTAL_SALES, :guessed}]}] ++
        for _ <- 1..4, do: {uuid(), [{:PREDICTION_NOMINATION_TOTAL_SALES, :missed}]}

    messages = [
      prebidding_started(auction, lots),
      bid(auction, lot1, 1, gosha, at: "2026-11-10T10:00:01Z"),
      bid(auction, lot1, 2, dasha),
      bid(auction, lot1, 3, gosha),
      bid(auction, lot1, 4, dasha),
      bid(auction, lot1, 5, gosha),
      bid(auction, lot2, 1, dasha, at: "2026-11-10T10:00:02Z"),
      bid(auction, lot2, 2, vitya, origin: :proxy),
      bid(auction, lot3, 1, gosha),
      lot_sold(auction, lot1, 6, gosha),
      lot_sold(auction, lot2, 3, vitya),
      lot_sold(auction, lot3, 2, gosha),
      invoice_paid(auction, lot1, gosha),
      invoice_paid(auction, lot2, vitya),
      invoice_paid(auction, lot3, gosha),
      invoice_paid(auction, uuid(), gosha),
      raffle_drawn(auction, tickets, 3),
      auction_finished(auction, lots),
      prediction_results(auction, answers)
    ]

    {auction, messages}
  end
end
