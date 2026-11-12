defmodule Achievements.UUID7 do
  @moduledoc """
  UUIDv7 (RFC 9562) в канонической форме: строчные буквы с дефисами, как
  требует контракт для id выдачи и `event_id` строки outbox. Первые 48 бит —
  миллисекунды Unix, поэтому id растут со временем, остальное — случайные биты.
  """

  @spec generate(DateTime.t()) :: String.t()
  def generate(at \\ DateTime.utc_now()) do
    ms = DateTime.to_unix(at, :millisecond)
    <<rand_a::12, rand_b::62, _::6>> = :crypto.strong_rand_bytes(10)

    <<ms::48, 7::4, rand_a::12, 2::2, rand_b::62>>
    |> Ecto.UUID.cast!()
  end
end
