defmodule Achievements.Metrics do
  @moduledoc """
  Метрики сервиса по OTLP, когда среда дала адрес Collector
  (`config/runtime.exs`); без него инструменты пишут в пустоту.

  - `solguficky.failures` — счётчик отказов с атрибутами `service` и
    `error_category` по словарю logging.md;
  - `achievements.stream.pending` — сколько сообщений стрима модуля актор
    ачивки ещё не прочитал, по последней выборке; атрибуты `achievement` и
    `stream`. Позиция чтения живёт в базе, а не в потребителе JetStream, поэтому
    отставание видно только пока актор жив.

  Процесс нужен только ради таблицы ETS с последними значениями отставания:
  наблюдаемый датчик читает её по такту экспорта, а таблице нужен владелец,
  который живёт дольше актора.
  """
  use GenServer

  require OpenTelemetryAPIExperimental.Counter, as: Counter
  require OpenTelemetryAPIExperimental.ObservableGauge, as: Gauge

  @table __MODULE__
  @failures :"solguficky.failures"
  @pending :"achievements.stream.pending"

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "Отказ категории `category` из словаря logging.md."
  @spec failure(String.t()) :: :ok
  def failure(category) do
    Counter.add(@failures, 1, %{
      service: Achievements.Telemetry.service(),
      error_category: category
    })

    :ok
  end

  @doc "Последнее отставание актора ачивки от стрима."
  @spec pending(String.t(), String.t(), non_neg_integer()) :: :ok
  def pending(code, stream, count) do
    :ets.insert(@table, {{code, stream}, count})
    :ok
  rescue
    # Таблицы нет вне дерева приложения — в L0-тестах актора.
    ArgumentError -> :ok
  end

  @doc false
  def observe(_args) do
    for {{code, stream}, count} <- :ets.tab2list(@table),
        do: {count, %{achievement: code, stream: stream}}
  end

  @impl true
  def init(_opts) do
    :ets.new(@table, [:named_table, :public, :set, write_concurrency: true])
    Counter.create(@failures, %{description: "Failures by category", unit: :"1"})

    Gauge.create(@pending, &__MODULE__.observe/1, [], %{
      description: "Stream messages an achievement actor has not read yet",
      unit: :"1"
    })

    {:ok, %{}}
  end
end
