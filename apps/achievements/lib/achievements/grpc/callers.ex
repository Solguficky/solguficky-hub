defmodule Achievements.Grpc.Callers do
  @moduledoc """
  Вызывающий по своему токену (ADR-056): `authorization: Bearer <token>`
  сверяется с таблицей `:callers` — токеном каждого вызывающего из колонки
  Caller каталога integration.md, — и вызывающий допускается только к методам,
  где он объявлен. Нет токена, чужой токен, вызывающий не из колонки Caller —
  `UNAUTHENTICATED`. Health принимает всех: его зовут пробы.

  Интерцептор стоит после `Achievements.Grpc.Boundary` и записи не пишет: поля
  общего формата отказа вызывающему — `caller_refusal` со значением
  `missing_token`, `unknown_token` или `not_declared` и `caller` с узлом
  вызывающего (integration.md, «Service authentication») — он кладёт в
  метаданные процесса вызова, и их несёт запись границы. Токен в запись не
  попадает.
  """
  @behaviour GRPC.Server.Interceptor

  @service "/achievements.v1.AchievementsService/"

  # Колонка Caller раздела «Achievements gRPC» integration.md.
  @methods %{
    "ListMyAchievements" => [:hub_bot, :auction_bot],
    "GetEventAchievements" => [:hub_bot, :auction_bot],
    "GetAchievementImage" => [:hub_bot, :auction_bot],
    "GrantAchievement" => [:hub_bot]
  }

  @impl true
  def init(opts), do: opts

  @impl true
  def call(req, stream, next, _opts) do
    operation = Achievements.Grpc.Boundary.operation(stream)

    # Таблица читается только для методов сервиса: health ей не подчиняется.
    verdict =
      if String.starts_with?(operation, @service),
        do: admit(operation, GRPC.Stream.get_headers(stream), callers()),
        else: :health

    case verdict do
      :health ->
        next.(req, stream)

      {:ok, caller} ->
        Logger.metadata(caller: node_name(caller))
        next.(req, stream)

      {:error, refusal, caller} ->
        Logger.metadata([caller_refusal: Atom.to_string(refusal)] ++ caller_field(caller))
        raise GRPC.RPCError, status: :unauthenticated, message: message(refusal)
    end
  end

  @doc """
  Решение по вызову методу сервиса: операция, заголовки и таблица
  `%{caller => token}`. Отказ — вид из общего формата и вызывающий, если токен
  его назвал.
  """
  @spec admit(String.t(), map(), %{atom() => String.t()}) ::
          {:ok, atom()} | {:error, :missing_token | :unknown_token | :not_declared, atom() | nil}
  def admit(@service <> method, headers, callers) do
    with {:ok, token} <- bearer(headers),
         {:ok, caller} <- caller(token, callers) do
      if caller in Map.get(@methods, method, []),
        do: {:ok, caller},
        else: {:error, :not_declared, caller}
    end
  end

  @doc "Узел вызывающего, как его называет AppHost: `hub_bot` — `hub-bot`."
  @spec node_name(atom()) :: String.t()
  def node_name(caller), do: caller |> Atom.to_string() |> String.replace("_", "-")

  defp bearer(%{"authorization" => "Bearer " <> token}) when token != "", do: {:ok, token}
  defp bearer(_headers), do: {:error, :missing_token, nil}

  # Сравнение по хэшу: равная длина для hash_equals и время, не зависящее от
  # совпавшего префикса.
  defp caller(token, callers) do
    digest = :crypto.hash(:sha256, token)

    case Enum.find(callers, fn {_, known} ->
           :crypto.hash_equals(:crypto.hash(:sha256, known), digest)
         end) do
      {caller, _} -> {:ok, caller}
      nil -> {:error, :unknown_token, nil}
    end
  end

  defp caller_field(nil), do: []
  defp caller_field(caller), do: [caller: node_name(caller)]

  defp message(:missing_token), do: "no caller token"
  defp message(:unknown_token), do: "unknown caller token"
  defp message(:not_declared), do: "the caller is not declared for this method"

  defp callers, do: Application.fetch_env!(:achievements, :callers)
end
