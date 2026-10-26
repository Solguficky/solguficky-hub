defmodule Achievements.Relay do
  @moduledoc """
  Релей outbox: переносит неопубликованные строки в JetStream по порядку
  `position` и отмечает каждую после подтверждения стрима. Заголовок
  `Nats-Msg-Id` — `event_id` строки, поэтому повтор после сбоя между
  подтверждением и отметкой стрим отсекает в окне дедупликации, а за окном —
  потребитель по `event_id`.

  Отказ шины останавливает пачку на первой неподтверждённой строке: следующая
  не обгоняет её, и тик повторяется через интервал. Релей краем цепочки не
  является и `request_id` не рождает; запись о тике пишется только при
  отказе.
  """
  use GenServer

  import Ecto.Query
  require Logger

  alias Achievements.{Outbox, Repo}

  @batch 100

  def start_link(opts),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  @doc "Переносит одну пачку и возвращает число опубликованных строк."
  @spec run_once(GenServer.server()) :: non_neg_integer()
  def run_once(server \\ __MODULE__), do: GenServer.call(server, :run_once, 30_000)

  @impl true
  def init(opts) do
    state = %{
      connection: Keyword.fetch!(opts, :connection),
      interval: Keyword.get(opts, :interval, 1_000),
      timeout: Keyword.get(opts, :timeout, 5_000)
    }

    {:ok, schedule(state)}
  end

  @impl true
  def handle_info(:tick, state) do
    relay(state)
    {:noreply, schedule(state)}
  end

  @impl true
  def handle_call(:run_once, _from, state), do: {:reply, relay(state), state}

  defp schedule(state) do
    Process.send_after(self(), :tick, state.interval)
    state
  end

  defp relay(state) do
    from(o in Outbox, where: is_nil(o.published_at), order_by: o.position, limit: @batch)
    |> Repo.all()
    |> Enum.reduce_while(0, fn row, published ->
      case publish(state, row) do
        :ok ->
          from(o in Outbox, where: o.event_id == ^row.event_id)
          |> Repo.update_all(set: [published_at: DateTime.utc_now()])

          {:cont, published + 1}

        {:error, reason} ->
          Logger.warning("outbox relay failed",
            operation: "outbox_relay",
            result: "error",
            error_category: "dependency_unavailable",
            error: reason,
            event_id: row.event_id
          )

          {:halt, published}
      end
    end)
  end

  @doc false
  def publish(%{connection: connection, timeout: timeout}, %Outbox{} = row) do
    headers = [{"Nats-Msg-Id", row.event_id}]

    case Gnat.request(connection, row.subject, row.payload,
           headers: headers,
           receive_timeout: timeout
         ) do
      {:ok, %{body: body}} -> ack(body)
      {:error, reason} -> {:error, inspect(reason)}
    end
  catch
    # Соединение ещё не поднято или потеряно: процесса с таким именем нет.
    :exit, reason -> {:error, Exception.format_exit(reason)}
  end

  # Ответ JetStream на публикацию — PubAck в JSON протокола NATS; поле error —
  # отказ стрима, например нет стрима на subject.
  @doc false
  def ack(body) do
    case JSON.decode(body) do
      {:ok, %{"error" => %{"description" => description}}} -> {:error, description}
      {:ok, %{"stream" => _, "seq" => _}} -> :ok
      _ -> {:error, "not a JetStream publish acknowledgement"}
    end
  end
end
