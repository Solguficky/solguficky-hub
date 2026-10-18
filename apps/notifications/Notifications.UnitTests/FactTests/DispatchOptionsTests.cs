using Notifications.Facts;
using Notifications.Messaging;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Горизонт хранения не короче срока жизни ключей событий: ключ повода живёт в
/// строке, и раннее удаление пропустило бы повтор события вторым фактом.
/// </summary>
public class DispatchOptionsTests
{
    private static readonly ConsumerOptions Consumer = new();

    [Fact]
    public void IsValid_Defaults_Accepted() => DispatchOptions.IsValid(new DispatchOptions(), Consumer).ShouldBeTrue();

    [Fact]
    public void IsValid_RetentionEqualToKeyRetention_Accepted() =>
        DispatchOptions.IsValid(new DispatchOptions { Retention = Consumer.KeyRetention }, Consumer).ShouldBeTrue();

    [Fact]
    public void IsValid_RetentionShorterThanKeyRetention_Rejected() =>
        DispatchOptions.IsValid(
            new DispatchOptions { Retention = Consumer.KeyRetention - TimeSpan.FromSeconds(1) },
            Consumer).ShouldBeFalse();

    [Fact]
    public void IsValid_ZeroAttempts_Rejected() =>
        DispatchOptions.IsValid(new DispatchOptions { MaxAttempts = 0 }, Consumer).ShouldBeFalse();

    [Fact]
    public void IsValid_ZeroPrunePeriod_Rejected() =>
        DispatchOptions.IsValid(new DispatchOptions { PrunePeriod = TimeSpan.Zero }, Consumer).ShouldBeFalse();

    [Fact]
    public void Options_Default_ThreeAttemptsThirtyDays()
    {
        var options = new DispatchOptions();

        options.MaxAttempts.ShouldBe(3);
        options.Retention.ShouldBe(TimeSpan.FromDays(30));
    }
}
