using System.Text.Json;
using NATS.Client.Core;
using Notifications.Replica;

namespace Notifications.Infrastructure;

/// <summary>
/// Пишет одну запись о потере соединения с шиной и одну о его восстановлении.
/// </summary>
/// <remarks>
/// Без записи простой потребителя неотличим от пустой шины: при разрыве чтение
/// durable не падает, а просто ждёт, и сообщений нет в обоих случаях. Клиент
/// переподключается сам и о каждой неудачной попытке сообщает отдельным
/// событием; запись на попытку засыпала бы лог за минуту простоя, поэтому
/// пишется только переход между состояниями (<see cref="BusConnectionState" />).
///
/// Подписка снимается на остановке хоста, раньше, чем контейнер закроет
/// соединение: иначе штатная остановка сервиса выглядела бы потерей шины.
/// </remarks>
public sealed class BusConnectionWatcher(
    NatsConnection connection,
    TimeProvider clock,
    ILogger<BusConnectionWatcher> logger) : IHostedService
{
    /// <summary>
    /// Имя операции обеих записей, одно у всех потребителей шины: запрос по
    /// нему собирает потерю шины у Notifications и бота сразу.
    /// </summary>
    public const string Operation = "nats.connection";

    private readonly BusConnectionState state = new();

    public Task StartAsync(CancellationToken cancellationToken)
    {
        connection.ConnectionDisconnected += OnDisconnected;
        connection.ConnectionOpened += OnOpened;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        connection.ConnectionDisconnected -= OnDisconnected;
        connection.ConnectionOpened -= OnOpened;
        return Task.CompletedTask;
    }

    private ValueTask OnDisconnected(object? sender, NatsEventArgs args)
    {
        if (state.Lose(clock.GetUtcNow()))
        {
            ReplicaTelemetry.Fail("dependency_unavailable");
            Write(LogLevel.Warning, new Dictionary<string, object>
            {
                ["service"] = NotificationsHost.ServiceId,
                ["operation"] = Operation,
                ["result"] = "error",
                // Переход мгновенный, поэтому длительность нулевая; каркас
                // требует поле всегда, а длину простоя несёт запись о
                // восстановлении.
                ["duration_us"] = 0L,
                ["error_category"] = "dependency_unavailable",
                // Текст события клиента не пишется: гарантии, что в нём нет
                // адреса сервера с учётными данными из строки подключения, нет.
                ["error"] = "connection to NATS lost; reconnecting",
            });
        }

        return ValueTask.CompletedTask;
    }

    private ValueTask OnOpened(object? sender, NatsEventArgs args)
    {
        if (state.Restore(clock.GetUtcNow()) is { } outage)
        {
            Write(LogLevel.Information, new Dictionary<string, object>
            {
                ["service"] = NotificationsHost.ServiceId,
                ["operation"] = Operation,
                ["result"] = "ok",
                ["duration_us"] = (long)outage.TotalMicroseconds,
            });
        }

        return ValueTask.CompletedTask;
    }

    // JSON в теле строки — та же форма, что у записей реплики и релея.
    private void Write(LogLevel level, Dictionary<string, object> fields) =>
        logger.Log(level, "{bus_connection}", JsonSerializer.Serialize(fields));
}

/// <summary>
/// Состояние соединения с точки зрения записи: потеряно оно или нет и с какого
/// момента. Отвечает только на переходы, поэтому повтор события о разрыве и
/// первое открытие соединения на старте записи не дают.
/// </summary>
public sealed class BusConnectionState
{
    private readonly Lock gate = new();
    private DateTimeOffset? lostAt;

    /// <summary>Отмечает потерю; true — если это новая потеря, а не повтор.</summary>
    public bool Lose(DateTimeOffset now)
    {
        lock (gate)
        {
            if (lostAt is not null)
            {
                return false;
            }

            lostAt = now;
            return true;
        }
    }

    /// <summary>Отмечает восстановление; длительность простоя — если потеря была.</summary>
    public TimeSpan? Restore(DateTimeOffset now)
    {
        lock (gate)
        {
            if (lostAt is not { } since)
            {
                return null;
            }

            lostAt = null;
            return now - since;
        }
    }
}
