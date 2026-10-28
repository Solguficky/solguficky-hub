defmodule Achievements.Settings do
  @moduledoc """
  Разбор переменных среды, которые читает `config/runtime.exs`. Отказ называет
  переменную, но не повторяет её значение: в адресе могут быть учётные данные.
  """

  @doc "Порт из переменной `name`, `default` — если она не задана."
  @spec port!(String.t(), String.t()) :: :inet.port_number()
  def port!(name, default) do
    value = System.get_env(name, default)

    case Integer.parse(value) do
      {port, ""} when port in 1..65_535 -> port
      _ -> raise "#{name} is not a TCP port"
    end
  end

  @doc """
  Таблица вызывающих gRPC (ADR-056): токен каждого вызывающего из колонки
  Caller — `<имя>` из `names` читается из `ACHIEVEMENTS_CALLER_TOKEN_<ИМЯ>`.
  Таблица полна всегда: без токена узел не стартует и называет переменную.
  """
  @spec callers!([atom()]) :: %{atom() => String.t()}
  def callers!(names) do
    Map.new(names, fn caller ->
      name = "ACHIEVEMENTS_CALLER_TOKEN_" <> String.upcase(Atom.to_string(caller))

      case System.get_env(name) do
        token when token in [nil, ""] -> raise "#{name} is not set: a caller token is required"
        token -> {caller, token}
      end
    end)
  end

  @doc """
  Адрес NATS для релея outbox. Пустой адрес — шины в запуске нет: релей не
  стартует, строки копятся в outbox и уйдут, когда адрес появится.
  """
  @spec nats!(String.t() | nil) :: map() | nil
  def nats!(url) when url in [nil, ""], do: nil

  def nats!(url) do
    case URI.parse(url) do
      %URI{scheme: "nats", host: host, port: port, userinfo: userinfo}
      when is_binary(host) and host != "" ->
        Map.merge(%{host: host, port: port || 4222}, credentials(userinfo))

      _ ->
        raise "ACHIEVEMENTS_NATS_URL is not a nats:// URL"
    end
  end

  # Учётку кладёт в адрес Aspire (`nats://nats:<пароль>@host:port`). Пароль
  # gnat берёт функцией: строкой он попал бы в отчёт о падении супервизора.
  defp credentials(nil), do: %{}

  defp credentials(userinfo) do
    case String.split(userinfo, ":", parts: 2) do
      [user, password] ->
        password = URI.decode(password)
        %{username: URI.decode(user), password: fn -> password end}

      [user] ->
        %{username: URI.decode(user)}
    end
  end
end
