defmodule Achievements.Facts do
  @moduledoc "Факт стрима по subject: декодер — код protoc-gen-elixir из неизменённых proto."
  alias Auction.V1.{InvoiceEvent, LotEvent}

  @type t :: {:invoice, InvoiceEvent.t()} | {:lot, LotEvent.t()} | :ignored

  @spec decode(String.t(), binary()) :: t()
  def decode("events.auction.invoice_paid", body), do: {:invoice, InvoiceEvent.decode(body)}
  def decode("events.auction.bid_placed", body), do: {:lot, LotEvent.decode(body)}
  def decode(_subject, _body), do: :ignored

  def event_id({_, %{event_id: id}}), do: id
  def event_id(:ignored), do: nil
end
