defmodule Achievements.Test.Node do
  @moduledoc false
  # Настоящий узел Achievements для L1 над PostgreSQL и NATS в Testcontainers с
  # тестовыми определениями: подъём, публикация фактов Auction и ожидание
  # акторов. Механику реестра проверяют правила test/support/rules.ex, а не
  # ачивки поставки.

  import Ecto.Query
  import ExUnit.Assertions

  alias Achievements.{Definition, Repo}
  alias Achievements.Test.Rules
  alias Auction.V1.{InvoiceEvent, InvoicePaid, InvoiceState}
  alias Gnat.Jetstream.API.Stream
  alias Testcontainers.{Container, PostgresContainer}

  @hub_token "hub-bot-token"
  @auction_token "auction-bot-token"

  # Дата начала «mid» — между фактами сценария набора, «late» — после всех.
  @definitions [
    {"first_buyer", :one, :rule, ~U[2026-01-01 00:00:00Z], Rules.Payer},
    {"buyer", :many, :rule, ~U[2026-01-01 00:00:00Z], Rules.Payer},
    {"two_lots", :many, :rule, ~U[2026-01-01 00:00:00Z], Rules.TwoLots},
    {"thanks", :many, :manual, ~U[2026-01-01 00:00:00Z], nil},
    {"mid", :many, :rule, ~U[2026-10-05 00:00:00Z], Rules.Payer},
    {"late", :many, :rule, ~U[2100-01-01 00:00:00Z], Rules.Payer},
    {"flaky", :many, :rule, ~U[2026-01-01 00:00:00Z], Rules.Flaky}
  ]

  # Актор «late» стартует с будущей даты и стрима не читает.
  @reading ~w(first_buyer buyer two_lots mid flaky)

  def hub_token, do: @hub_token
  def auction_token, do: @auction_token
  def reading, do: @reading

  @doc "Поднимает контейнеры и узел; возвращает канал gRPC к нему."
  def start! do
    {:ok, _} = Application.ensure_all_started(:testcontainers)
    {:ok, _} = Testcontainers.start_link()

    {:ok, postgres} =
      Testcontainers.start_container(
        PostgresContainer.new()
        |> PostgresContainer.with_image("postgres:16-alpine")
      )

    {:ok, nats} =
      Container.new("nats:2")
      |> Container.with_cmd(["-js"])
      |> Container.with_exposed_port(4222)
      |> Container.with_waiting_strategy(
        Testcontainers.LogWaitStrategy.new(~r/Server is ready/, 30_000)
      )
      |> Testcontainers.start_container()

    image_dir = Path.join(System.tmp_dir!(), "achievements-#{System.unique_integer([:positive])}")
    File.mkdir_p!(image_dir)
    File.write!(Path.join(image_dir, "buyer.png"), "png bytes")

    grpc_port = Enum.random(40_000..49_999)
    db = PostgresContainer.connection_parameters(postgres)
    nats_url = "nats://#{Testcontainers.get_host(nats)}:#{Container.mapped_port(nats, 4222)}"

    Application.put_env(:achievements, Repo, Keyword.put(db, :ssl, false))
    Application.put_env(:achievements, :grpc_port, grpc_port)
    Application.put_env(:achievements, :nats, Achievements.Settings.nats!(nats_url))
    Application.put_env(:achievements, :relay_interval, :timer.hours(1))

    Application.put_env(:achievements, :callers, %{
      hub_bot: @hub_token,
      auction_bot: @auction_token
    })

    Application.put_env(:achievements, :definitions, definitions(image_dir))
    Application.put_env(:achievements, :actor, expires_ms: 300, retry_ms: 200)

    {:ok, _} = Application.ensure_all_started(:achievements)
    {:ok, _} = Application.ensure_all_started(:grpc)
    wait_until(fn -> Process.whereis(:gnat) end, "NATS connection did not come up")

    create_streams()

    {:ok, channel} =
      GRPC.Stub.connect("127.0.0.1:#{grpc_port}", adapter: GRPC.Client.Adapters.Mint)

    channel
  end

  @doc "Останавливает узел и снимает тестовую конфигурацию."
  def stop do
    Application.stop(:achievements)
    Enum.each([:definitions, :callers, :actor], &Application.delete_env(:achievements, &1))
  end

  def create_streams do
    {:ok, _} =
      Stream.create(:gnat, %Stream{name: "AUCTION_EVENTS", subjects: ["events.auction.>"]})

    {:ok, _} =
      Stream.create(:gnat, %Stream{
        name: "ACHIEVEMENTS_EVENTS",
        subjects: ["events.achievements.>"]
      })
  end

  @doc "Оплаченный счёт победителя в аукционе."
  def paid(auction, winner, occurred_at) do
    %InvoiceEvent{
      event_id: uuid(),
      invoice_id: uuid(),
      version: 2,
      occurred_at: DateTime.to_iso8601(occurred_at),
      state: %InvoiceState{auction_id: auction, lot_id: uuid(), winner_id: winner},
      occasion: {:invoice_paid, %InvoicePaid{}}
    }
  end

  def publish(fact, reading \\ @reading), do: publish_all([fact], reading)

  # Без Nats-Msg-Id: повтор того же факта приходит в стрим новым номером, как
  # повторная публикация модуля за окном дедупликации.
  def publish_all(facts, reading \\ @reading) do
    seq =
      facts
      |> Enum.map(&publish_raw("events.auction.invoice_paid", InvoiceEvent.encode(&1)))
      |> List.last()

    wait_for(reading, seq)
    seq
  end

  def publish_raw(subject, payload) do
    {:ok, %{body: body}} = Gnat.request(:gnat, subject, payload)
    %{"seq" => seq} = JSON.decode!(body)
    seq
  end

  def wait_for(codes, seq) do
    wait_until(
      fn -> Enum.all?(codes, &(cursor(&1) >= seq)) end,
      "actors #{inspect(codes)} did not reach stream sequence #{seq}"
    )
  end

  def cursor(code), do: Achievements.Ledger.cursor(code, "AUCTION_EVENTS") || 0

  def holders(auction, code) do
    from(g in "grant",
      where: g.event_key == ^auction and g.achievement_code == ^code and g.state == "live",
      order_by: g.granted_at,
      select: type(g.identity_id, Ecto.UUID)
    )
    |> Repo.all()
  end

  def auth(token), do: %{"authorization" => "Bearer " <> token}

  def uuid, do: Achievements.UUID7.generate()

  def wait_until(check, message, attempts \\ 100) do
    cond do
      check.() -> :ok
      attempts == 0 -> flunk(message)
      true -> Process.sleep(100) && wait_until(check, message, attempts - 1)
    end
  end

  defp definitions(image_dir) do
    for {code, recipients, issue, starts_at, rule} <- @definitions do
      %Definition{
        code: code,
        title: "Title #{code}",
        description: "Description #{code}",
        recipients: recipients,
        issue: issue,
        event_kind: :auction,
        starts_at: starts_at,
        rule: rule,
        image: if(code == "buyer", do: Path.join(image_dir, "buyer.png"))
      }
    end
  end
end
