using Notifications.Facts;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Границы срока годности: отрицательный снял бы каждый факт, огромный
/// переполнил бы момент и уронил применение каждого события сходки.
/// </summary>
public class FactOptionsTests
{
    [Theory]
    [InlineData("00:00:00")]
    [InlineData("1.00:00:00")]
    [InlineData("365.00:00:00")]
    public void IsValid_StaleAfterWithinBounds_Accepted(string staleAfter) =>
        FactOptions.IsValid(new FactOptions { StaleAfter = TimeSpan.Parse(staleAfter) }).ShouldBeTrue();

    [Theory]
    [InlineData("-00:00:01")]
    [InlineData("365.00:00:01")]
    public void IsValid_StaleAfterOutOfBounds_Rejected(string staleAfter) =>
        FactOptions.IsValid(new FactOptions { StaleAfter = TimeSpan.Parse(staleAfter) }).ShouldBeFalse();

    [Fact]
    public void StaleAfter_Default_IsOneDay() => new FactOptions().StaleAfter.ShouldBe(TimeSpan.FromHours(24));
}
