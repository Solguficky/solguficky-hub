using Microsoft.Extensions.Configuration;
using Notifications.Messaging;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.MessagingTests;

/// <summary>Срок ключей повтора по стриму, умолчания в коде (PER-761).</summary>
public class ConsumerOptionsTests
{
    [Fact]
    public void KeyRetention_Defaults_StreamWindowPlusDay()
    {
        var options = new ConsumerOptions();

        options.KeyRetentionFor("MEETUPS_EVENTS").ShouldBe(TimeSpan.FromDays(8));
        options.KeyRetentionFor("IDENTITY_EVENTS").ShouldBe(TimeSpan.FromDays(8));
        options.KeyRetentionFor("AUCTION_EVENTS").ShouldBe(TimeSpan.FromDays(91));
        options.LongestKeyRetention.ShouldBe(TimeSpan.FromDays(91));
    }

    [Fact]
    public void KeyRetention_UnknownStream_Throws() =>
        Should.Throw<InvalidOperationException>(() => new ConsumerOptions().KeyRetentionFor("OTHER_EVENTS"));

    [Fact]
    public void KeyRetention_OneStreamOverridden_OthersKeepDefaults()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [$"{ConsumerOptions.SectionName}:KeyRetention:AUCTION_EVENTS"] = "120.00:00:00",
            })
            .Build();

        var options = configuration.GetSection(ConsumerOptions.SectionName).Get<ConsumerOptions>().ShouldNotBeNull();

        options.KeyRetentionFor("AUCTION_EVENTS").ShouldBe(TimeSpan.FromDays(120));
        options.KeyRetentionFor("MEETUPS_EVENTS").ShouldBe(TimeSpan.FromDays(8));
    }
}
