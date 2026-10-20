using Notifications.Domain;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.DomainTests;

/// <summary>Словарь настройки перебитий и решение по ней (PER-514).</summary>
public class OutbidFrequenciesTests
{
    public static TheoryData<OutbidFrequency> Known() =>
        [.. Enum.GetValues<OutbidFrequency>().Where(value => value != OutbidFrequency.Unspecified)];

    [Fact]
    public void When_NoPreferenceStored_Expect_EveryOutbidSentAtOnce()
    {
        OutbidFrequencies.Decide(null).ShouldBeOfType<OutbidDecision.Send>();
    }

    [Fact]
    public void When_Every_Expect_SentAtOnce()
    {
        OutbidFrequencies.Decide(OutbidFrequency.Every).ShouldBeOfType<OutbidDecision.Send>();
    }

    [Fact]
    public void When_Off_Expect_Suppressed()
    {
        OutbidFrequencies.Decide(OutbidFrequency.Off).ShouldBeOfType<OutbidDecision.Suppress>();
    }

    [Theory]
    [InlineData(OutbidFrequency.AtMostEvery5Minutes, 5)]
    [InlineData(OutbidFrequency.AtMostEvery15Minutes, 15)]
    [InlineData(OutbidFrequency.AtMostEvery60Minutes, 60)]
    public void When_AtMost_Expect_CollectedIntoWindowOfThatLength(OutbidFrequency frequency, int minutes)
    {
        OutbidFrequencies.Decide(frequency).ShouldBeOfType<OutbidDecision.Collect>()
            .Window.ShouldBe(TimeSpan.FromMinutes(minutes));
    }

    [Theory]
    [MemberData(nameof(Known))]
    public void When_EveryContractValueStored_Expect_SameValueRead(OutbidFrequency frequency)
    {
        // Каждое значение контракта знает и хранение: значение, добавленное в
        // enum без строки словаря, роняет этот тест, а не команду в проде.
        OutbidFrequencies.IsKnown(frequency).ShouldBeTrue();
        OutbidFrequencies.FromStorage(OutbidFrequencies.Storage(frequency)).ShouldBe(frequency);
    }

    [Fact]
    public void When_Unspecified_Expect_NotKnownAndNotStorable()
    {
        OutbidFrequencies.IsKnown(OutbidFrequency.Unspecified).ShouldBeFalse();
        Should.Throw<ArgumentOutOfRangeException>(() => OutbidFrequencies.Storage(OutbidFrequency.Unspecified));
    }

    [Fact]
    public void When_LiveFinalOutbidsAreOff_Expect_OutbidSuppressedWhateverTheFrequency()
    {
        OutbidFrequencies.ForLiveFinal(new OutbidDecision.Send(), true, false)
            .ShouldBeOfType<OutbidDecision.Suppress>();
        OutbidFrequencies.ForLiveFinal(new OutbidDecision.Collect(TimeSpan.FromMinutes(5)), true, false)
            .ShouldBeOfType<OutbidDecision.Suppress>();
    }

    [Fact]
    public void When_LiveFinalOutbidsAreOn_Expect_FrequencyDecisionKept()
    {
        OutbidFrequencies.ForLiveFinal(new OutbidDecision.Collect(TimeSpan.FromMinutes(15)), true, true)
            .ShouldBeOfType<OutbidDecision.Collect>().Window.ShouldBe(TimeSpan.FromMinutes(15));
    }

    [Fact]
    public void When_NotLive_Expect_FrequencyDecisionKeptEvenIfFinalOutbidsAreOff()
    {
        OutbidFrequencies.ForLiveFinal(new OutbidDecision.Send(), false, false)
            .ShouldBeOfType<OutbidDecision.Send>();
    }

    [Fact]
    public void When_UnknownStoredValue_Expect_Refused()
    {
        Should.Throw<ArgumentOutOfRangeException>(() => OutbidFrequencies.FromStorage("hourly"));
    }
}
