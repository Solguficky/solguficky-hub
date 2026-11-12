defmodule Achievements.Actor do
  @moduledoc """
  Актор ачивки с правилом: читает стрим модуля по одному сообщению и отдаёт
  каждое в транзакцию `Achievements.Ledger.apply/6` (ADR-077, п. 3,
  дополнение 2026-10-26).

  Позиция чтения — строка базы в транзакции факта. Потребитель JetStream
  эфемерный: актор заводит его при старте с позиции + 1, а без позиции — с даты
  начала ачивки, и сервер сам убирает его через `inactive_threshold`, когда
  актора нет. `max_ack_pending: 1` и выборка по одному дают «один факт в
  полёте»: следующий факт не обгоняет неподтверждённый, поэтому «первый» у
  ачивки с одним получателем — первый по номеру стрима.

  Выборка идёт своей подпиской на inbox, а не `Gnat.request`: JetStream
  доставляет сообщение выборки с subject факта, а не inbox, и разбор ответов
  запроса такое сообщение выбросил бы. Ответа нет дольше срока выборки —
  потребитель заводится заново с позиции.

  Подтверждение стриму — после commit. Откат — `-NAK` с задержкой и повтор
  того же сообщения; сбой между commit и подтверждением даёт повторную
  доставку, которую отсекает позиция.

  Актор — граница шины: одна запись каркаса лога на сообщение, которое что-то
  решило, — выдача, отказ, битое тело, — и на отказ соединения. Сообщения, которые
  правило не читает, пишутся на debug. Отказ шины и базы актор переживает
  записью и повтором через `retry`, а не падением: падение на каждом повторе
  исчерпало бы рестарты супервизора и погасило узел.
  """
  use GenServer, restart: :permanent

  require Logger

  alias Achievements.{Definition, Ledger, Metrics}
  alias Gnat.Jetstream.API.{Consumer, Message, Stream}

  @operation "achievement_fact"

  def child_spec(opts) do
    definition = Keyword.fetch!(opts, :definition)
    %{id: {__MODULE__, definition.code}, start: {__MODULE__, :start_link, [opts]}}
  end

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)

  @impl true
  def init(opts) do
    state = %{
      definition: Keyword.fetch!(opts, :definition),
      connection: Keyword.fetch!(opts, :connection),
      stream: Keyword.fetch!(opts, :stream),
      filter: Keyword.fetch!(opts, :filter_subject),
      expires_ms: Keyword.get(opts, :expires_ms, 5_000),
      retry_ms: Keyword.get(opts, :retry_ms, 1_000),
      inactive_ms: Keyword.get(opts, :inactive_ms, 60_000),
      consumer: nil,
      inbox: nil,
      sid: nil,
      waiting: nil
    }

    {:ok, state, {:continue, :connect}}
  end

  @impl true
  def handle_continue(:connect, state), do: connect(state)

  @impl true
  def handle_info(:connect, state), do: connect(state)
  def handle_info(:pull, state), do: pull(state)

  def handle_info({:pull_expired, ref}, %{waiting: ref} = state),
    do: reconnect(state, "stream_pull", "no answer to a pull within its expiry")

  # 100 — пульс сервера, ответом на выборку он не является: сторож ждёт дальше.
  def handle_info({:msg, %{sid: sid, status: "100"}}, %{sid: sid} = state),
    do: {:noreply, state}

  def handle_info({:msg, %{sid: sid} = message}, %{sid: sid} = state),
    do: answer(cancel_wait(state), message)

  # Ответы старой подписки и истёкшие сторожа никому не нужны.
  def handle_info(_stray, state), do: {:noreply, state}

  defp connect(state) do
    state = unsubscribe(state)

    with {:ok, name} <- create_consumer(state),
         {:ok, inbox, sid} <- subscribe(state) do
      send(self(), :pull)
      {:noreply, %{state | consumer: name, inbox: inbox, sid: sid}}
    else
      {:error, reason} ->
        bus_failure(state, "consumer_create", reason)
        Process.send_after(self(), :connect, state.retry_ms)
        {:noreply, state}
    end
  end

  defp create_consumer(state) do
    %Definition{code: code, starts_at: starts_at} = state.definition

    with {:ok, start} <- start_position(state, code, starts_at) do
      consumer = %Consumer{
        stream_name: state.stream,
        filter_subject: state.filter,
        ack_policy: :explicit,
        max_ack_pending: 1,
        ack_wait: :timer.seconds(30) * 1_000_000,
        inactive_threshold: state.inactive_ms * 1_000_000,
        description: "achievements #{code}"
      }

      case Consumer.create(state.connection, Map.merge(consumer, start)) do
        {:ok, %{name: name}} -> {:ok, name}
        {:error, reason} -> {:error, inspect(reason)}
      end
    end
  catch
    :exit, reason -> {:error, Exception.format_exit(reason)}
  end

  defp subscribe(state) do
    inbox =
      "_INBOX.achievements." <> Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)

    case Gnat.sub(state.connection, self(), inbox) do
      {:ok, sid} -> {:ok, inbox, sid}
      {:error, reason} -> {:error, inspect(reason)}
    end
  catch
    :exit, reason -> {:error, Exception.format_exit(reason)}
  end

  defp unsubscribe(%{sid: nil} = state), do: state

  defp unsubscribe(state) do
    Gnat.unsub(state.connection, state.sid)
    %{cancel_wait(state) | sid: nil, inbox: nil, consumer: nil}
  catch
    :exit, _ -> %{cancel_wait(state) | sid: nil, inbox: nil, consumer: nil}
  end

  # С позиции + 1, а без позиции — с даты начала ачивки. Дата раньше окна
  # хранения стрима — чтение с самого раннего факта и предупреждение.
  #
  # Позиция дальше последнего номера стрима значит, что стрим пересоздан и
  # нумерация пошла заново: с seq + 1 актор ждал бы вечно. Тогда позиция
  # сбрасывается и чтение идёт с даты начала — повтор уже обработанных фактов
  # отсекает строка дедупликации по event_id.
  defp start_position(state, code, starts_at) do
    case Ledger.cursor(code, state.stream) do
      seq when is_integer(seq) ->
        if recreated?(state, seq) do
          Logger.warning("achievement stream was recreated",
            operation: "consumer_create",
            result: "error",
            error_category: "invariant",
            error: "stream position #{seq} is past the end of the stream",
            achievement: code
          )

          Metrics.failure("invariant")
          :ok = Ledger.reset_cursor(code, state.stream)
          from_start(state, starts_at)
        else
          {:ok, %{deliver_policy: :by_start_sequence, opt_start_seq: seq + 1}}
        end

      nil ->
        from_start(state, starts_at)
    end
  rescue
    error in [DBConnection.ConnectionError, Postgrex.Error] -> {:error, Exception.message(error)}
  end

  defp from_start(state, starts_at) do
    warn_before_window(state, starts_at)
    {:ok, %{deliver_policy: :by_start_time, opt_start_time: starts_at}}
  end

  # Не ответивший стрим — не пересозданный: заведение потребителя скажет о нём
  # само.
  defp recreated?(state, seq) do
    match?(
      {:ok, %{state: %{last_seq: last}}} when seq > last,
      Stream.info(state.connection, state.stream)
    )
  end

  # Пустой стрим окна не имеет: его первый номер — 0.
  defp warn_before_window(state, starts_at) do
    with {:ok, %{state: %{first_seq: first_seq, first_ts: %DateTime{} = first}}}
         when first_seq > 0 <- Stream.info(state.connection, state.stream),
         :lt <- DateTime.compare(starts_at, first) do
      Logger.warning("achievement starts before the stream window",
        operation: "consumer_create",
        result: "error",
        error_category: "invariant",
        error: "start date #{DateTime.to_iso8601(starts_at)} is before the earliest fact",
        achievement: state.definition.code
      )

      Metrics.failure("invariant")
    end
  end

  defp pull(%{consumer: nil} = state), do: {:noreply, state}

  defp pull(state) do
    topic = "$JS.API.CONSUMER.MSG.NEXT.#{state.stream}.#{state.consumer}"
    body = JSON.encode!(%{batch: 1, expires: state.expires_ms * 1_000_000})

    case publish(state, topic, body, reply_to: state.inbox) do
      :ok ->
        ref = make_ref()
        Process.send_after(self(), {:pull_expired, ref}, state.expires_ms + state.retry_ms)
        {:noreply, %{state | waiting: ref}}

      {:error, reason} ->
        reconnect(state, "stream_pull", reason)
    end
  end

  defp answer(state, %{reply_to: "$JS.ACK." <> _} = message), do: process(state, message)

  # 404 — нет сообщений, 408 — выборка истекла: стрим прочитан.
  defp answer(state, %{status: status}) when status in ["404", "408"] do
    Metrics.pending(state.definition.code, state.stream, 0)
    send(self(), :pull)
    {:noreply, state}
  end

  # Потребителя нет или он сменился: сервер его убрал, перезапустился.
  defp answer(state, message),
    do: reconnect(state, "stream_pull", "consumer answered #{inspect(Map.get(message, :status))}")

  defp reconnect(state, operation, reason) do
    bus_failure(state, operation, reason)
    Process.send_after(self(), :connect, state.retry_ms)
    {:noreply, unsubscribe(state)}
  end

  defp process(state, message) do
    {:ok, meta} = Message.metadata(message)
    start = System.monotonic_time()

    result =
      Ledger.apply(state.definition, state.stream, meta.stream_seq, message.topic, message.body)

    fields = [
      operation: @operation,
      achievement: state.definition.code,
      stream_seq: meta.stream_seq,
      duration_us: since(start)
    ]

    case result do
      {:ok, outcome} ->
        _ = publish(state, message.reply_to, "+ACK", [])
        Metrics.pending(state.definition.code, state.stream, meta.num_pending)
        log(outcome, fields)
        send(self(), :pull)
        {:noreply, state}

      {:error, kind, reason} ->
        # Повтор того же сообщения не раньше, чем через retry: без задержки
        # JetStream отдал бы его сразу, и лежащая база или дефект правила
        # крутили бы цикл.
        _ =
          publish(
            state,
            message.reply_to,
            "-NAK " <> JSON.encode!(%{delay: state.retry_ms * 1_000_000}),
            []
          )

        {level, category} = failure(kind)

        Logger.log(
          level,
          "achievement fact failed",
          [result: "error", error_category: category, error: reason] ++ fields
        )

        Metrics.failure(category)
        Process.send_after(self(), :pull, state.retry_ms)
        {:noreply, state}
    end
  end

  # Отказ базы повторится сам, когда она вернётся; дефект правила стоит до
  # новой поставки и требует внимания.
  defp failure(:unavailable), do: {:warning, "dependency_unavailable"}
  defp failure(:rule), do: {:error, "unexpected"}

  defp publish(state, topic, body, opts) do
    case Gnat.pub(state.connection, topic, body, opts) do
      :ok -> :ok
      other -> {:error, inspect(other)}
    end
  catch
    :exit, reason -> {:error, Exception.format_exit(reason)}
  end

  defp cancel_wait(state), do: %{state | waiting: nil}

  defp log({:granted, rows}, fields),
    do: Logger.info("achievement fact applied", [result: "ok", granted: length(rows)] ++ fields)

  defp log({:undecodable, reason}, fields) do
    Logger.error(
      "achievement fact undecodable",
      [result: "error", error_category: "invariant", error: reason] ++ fields
    )

    Metrics.failure("invariant")
  end

  defp log(outcome, fields),
    do: Logger.debug("achievement fact skipped", [result: "ok", outcome: outcome] ++ fields)

  defp bus_failure(state, operation, reason) do
    Logger.warning("achievement stream unavailable",
      operation: operation,
      result: "error",
      error_category: "dependency_unavailable",
      error: reason,
      achievement: state.definition.code
    )

    Metrics.failure("dependency_unavailable")
  end

  defp since(start),
    do: System.convert_time_unit(System.monotonic_time() - start, :native, :microsecond)
end
