defmodule Achievements.DatabaseUrl do
  @moduledoc """
  Опции Repo из URI PostgreSQL в форме libpq: так строку кладут и AppHost
  (`PostgresConnection.Uri`), и среда в чарте. Режим TLS libpq пишет
  параметром `sslmode`, а Postgrex его не знает, поэтому параметр
  переводится здесь, а остальные параметры строки отвергаются: молча
  проигнорированный параметр подключения хуже отказа на старте.
  """

  @spec repo_options(String.t()) :: keyword()
  def repo_options(url) do
    uri = URI.parse(url)

    unless uri.scheme in ["postgres", "postgresql"] and is_binary(uri.host) do
      raise ArgumentError, "ACHIEVEMENTS_DATABASE_URL is not a postgres:// URI"
    end

    params = URI.decode_query(uri.query || "")

    case Map.keys(params) -- ["sslmode"] do
      [] ->
        :ok

      other ->
        raise ArgumentError,
              "ACHIEVEMENTS_DATABASE_URL has unsupported parameters: #{Enum.join(other, ", ")}"
    end

    [url: URI.to_string(%{uri | query: nil}), ssl: ssl(params["sslmode"], uri.host)]
  end

  # Умолчание libpq — prefer; Postgrex «попробуй TLS, иначе без него» не
  # умеет, поэтому без явного режима соединение идёт без TLS, как у
  # локального контейнера.
  defp ssl(mode, _host) when mode in [nil, "disable", "allow", "prefer"], do: false
  defp ssl("require", _host), do: [verify: :verify_none]

  # verify-ca проверяет цепочку, но не имя хоста; verify-full — и его.
  defp ssl("verify-ca", _host),
    do: [
      verify: :verify_peer,
      cacerts: :public_key.cacerts_get(),
      server_name_indication: :disable
    ]

  defp ssl("verify-full", host),
    do: [
      verify: :verify_peer,
      cacerts: :public_key.cacerts_get(),
      server_name_indication: String.to_charlist(host),
      customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)]
    ]

  defp ssl(_mode, _host),
    do: raise(ArgumentError, "ACHIEVEMENTS_DATABASE_URL has an unknown sslmode")
end
