using Notifications.Infrastructure;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.InfrastructureTests;

public class BusConnectionStateTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Lose_RepeatedWhileLost_ReportsLossOnce()
    {
        // Клиент сообщает о разрыве и на повторных неудачах: за минуту
        // простоя запись о потере должна быть одна.
        var state = new BusConnectionState();

        state.Lose(Now).ShouldBeTrue();
        state.Lose(Now.AddSeconds(2)).ShouldBeFalse();
        state.Lose(Now.AddSeconds(60)).ShouldBeFalse();
    }

    [Fact]
    public void Restore_AfterLoss_ReturnsOutageLength()
    {
        var state = new BusConnectionState();
        state.Lose(Now);

        state.Restore(Now.AddSeconds(61.5)).ShouldBe(TimeSpan.FromSeconds(61.5));
    }

    [Fact]
    public void Restore_WithoutLoss_ReportsNothing()
    {
        // Первое открытие соединения на старте — не восстановление.
        var state = new BusConnectionState();

        state.Restore(Now).ShouldBeNull();
    }

    [Fact]
    public void Lose_AfterRestore_ReportsNewLoss()
    {
        var state = new BusConnectionState();
        state.Lose(Now);
        state.Restore(Now.AddSeconds(10));

        state.Lose(Now.AddSeconds(20)).ShouldBeTrue();
        state.Restore(Now.AddSeconds(25)).ShouldBe(TimeSpan.FromSeconds(5));
    }
}
