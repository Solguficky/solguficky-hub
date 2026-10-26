# Варианты oneof как в Elixir protobuf: occasion = {:lot_sold, %LotSold{}} | ... | nil.
defmodule Occ do
  defmodule LotSold, do: defstruct([])
  defmodule LotUnsold, do: defstruct([])
  defmodule BidPlaced, do: defstruct(previous_leader_id: nil)

  # Источник значений: компилятор видит, что возвращается ровно три тега.
  def decode(n) do
    case n do
      7 -> {:bid_placed, %BidPlaced{}}
      10 -> {:lot_sold, %LotSold{}}
      _ -> {:lot_unsold, %LotUnsold{}}
    end
  end

  # Разбор без варианта {:lot_unsold, _}.
  def describe_missing(n) do
    case decode(n) do
      {:bid_placed, %BidPlaced{}} -> "bid"
      {:lot_sold, %LotSold{}} -> "sold"
    end
  end

  # Разбор с вариантом, которого нет (опечатка тега): виден ли «never matches»?
  def describe_typo(n) do
    case decode(n) do
      {:bid_placed, _} -> "bid"
      {:lot_sold, _} -> "sold"
      {:lot_unsold, _} -> "unsold"
      {:lot_sould, _} -> "typo"
    end
  end
end
