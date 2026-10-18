using Notifications.Facts;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>Сведение строк снятия в счёт по типам для метрики и лога.</summary>
public class WithdrawnFactsTests
{
    [Fact]
    public void ByType_RowsOfSeveralTypes_CountsEachTypeOnce() =>
        WithdrawnFacts.ByType(["meetup_changed", "meetup_published", "meetup_changed"])
            .ShouldBe([new WithdrawnFacts("meetup_changed", 2), new WithdrawnFacts("meetup_published", 1)]);

    [Fact]
    public void ByType_NoRows_IsEmpty() => WithdrawnFacts.ByType([]).ShouldBeEmpty();
}
