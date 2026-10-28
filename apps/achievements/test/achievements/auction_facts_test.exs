defmodule Achievements.AuctionFactsTest do
  use ExUnit.Case, async: true

  alias Achievements.{AuctionFacts, Fact}
  alias Auction.V1.{InvoiceEvent, InvoicePaid, InvoiceState, LotEvent, LotSold}

  @auction "5f0c7a3e-3c1d-5a8b-9e1f-2a4b6c8d0e1f"
  @winner "0192f5a0-0000-7000-8000-000000000001"
  @event_id "0192f5a0-0000-7000-8000-0000000000aa"

  # Полнота разбора (ADR-077, дополнение 2026-10-26): каждый повод каждого
  # конверта стрима отображён в доменный факт или явно пропущен.
  test "every occasion of every auction envelope is mapped or explicitly ignored" do
    for envelope <- AuctionFacts.envelopes() do
      assert Map.keys(AuctionFacts.occasions()[envelope]) |> Enum.sort() ==
               occasions(envelope) |> Enum.sort(),
             "#{inspect(envelope)} has an occasion without a mapping"
    end
  end

  test "every envelope of the auction contract with an occasion is read" do
    {:ok, modules} = :application.get_key(:achievements, :modules)

    contract =
      modules
      |> Enum.filter(&String.starts_with?(Atom.to_string(&1), "Elixir.Auction.V1."))
      |> Enum.filter(&Code.ensure_loaded?/1)
      |> Enum.filter(&function_exported?(&1, :__message_props__, 0))
      |> Enum.filter(&Keyword.has_key?(&1.__message_props__().oneof, :occasion))

    assert Enum.sort(contract) == Enum.sort(AuctionFacts.envelopes())
  end

  test "an occasion names exactly one envelope" do
    names = Enum.flat_map(AuctionFacts.envelopes(), &occasions/1)
    assert names -- Enum.uniq(names) == []
  end

  test "a paid invoice becomes a fact about its winner in its auction" do
    assert {:ok, %Fact{} = fact} =
             AuctionFacts.decode(
               "events.auction.invoice_paid",
               invoice_paid() |> InvoiceEvent.encode()
             )

    assert fact.kind == :invoice_paid
    assert fact.event_id == @event_id
    assert fact.event == {:auction, @auction}
    assert fact.subject == @winner
    assert fact.occurred_at == ~U[2026-10-28 12:00:00Z]
  end

  test "an occasion no rule reads is ignored without decoding the body" do
    assert AuctionFacts.decode("events.auction.lot_sold", "not a body") == :ignored

    assert AuctionFacts.decode(
             "events.auction.lot_sold",
             %LotEvent{occasion: {:lot_sold, %LotSold{}}} |> LotEvent.encode()
           ) ==
             :ignored
  end

  test "a subject outside the auction facts is ignored" do
    assert AuctionFacts.decode("events.meetups.meetup_cancelled", "x") == :ignored
    assert AuctionFacts.decode("events.auction.not_an_occasion", "x") == :ignored
  end

  test "a body that is not the envelope of its occasion is undecodable" do
    assert {:error, _} = AuctionFacts.decode("events.auction.invoice_paid", <<255, 255, 255>>)
  end

  test "a paid invoice without a canonical winner is undecodable" do
    event = put_in(invoice_paid().state.winner_id, "Not-A-UUID")

    assert {:error, reason} =
             AuctionFacts.decode("events.auction.invoice_paid", InvoiceEvent.encode(event))

    assert reason =~ "winner_id"
  end

  test "a paid invoice with an occurred_at that is not an instant is undecodable" do
    event = %{invoice_paid() | occurred_at: "yesterday"}

    assert {:error, reason} =
             AuctionFacts.decode("events.auction.invoice_paid", InvoiceEvent.encode(event))

    assert reason =~ "occurred_at"
  end

  defp invoice_paid do
    %InvoiceEvent{
      event_id: @event_id,
      invoice_id: "0192f5a0-0000-7000-8000-0000000000bb",
      version: 2,
      occurred_at: "2026-10-28T12:00:00Z",
      state: %InvoiceState{auction_id: @auction, lot_id: "lot", winner_id: @winner},
      occasion: {:invoice_paid, %InvoicePaid{}}
    }
  end

  defp occasions(envelope) do
    envelope.__message_props__().field_props
    |> Map.values()
    |> Enum.filter(&(&1.oneof == 0))
    |> Enum.map(& &1.name_atom)
  end
end
