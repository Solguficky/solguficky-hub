using Notifications.Facts;
using Notifications.Replica;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Соответствие очереди заявки правам и кругу: ADR-064, пункты 8, 12 и 14.
/// </summary>
public sealed class AccessQueuesTests
{
    [Theory]
    [InlineData(AccessQueue.Community, "manage_membership")]
    [InlineData(AccessQueue.Auction, "moderate_auction")]
    public void ModeratorRight_Queue_IsTheRightThatDecidesIt(AccessQueue queue, string right) =>
        AccessQueues.ModeratorRight(queue).ShouldBe(right);

    [Theory]
    [InlineData(AccessQueue.Community, "hub")]
    [InlineData(AccessQueue.Auction, "auction")]
    public void AdmissionRight_Queue_IsTheRightItsAdmissionGrants(AccessQueue queue, string right) =>
        AccessQueues.AdmissionRight(queue).ShouldBe(right);

    [Theory]
    [InlineData(AccessQueue.Community, "member", Identity.V1.GlobalRole.Member)]
    [InlineData(AccessQueue.Auction, "public", Identity.V1.GlobalRole.Guest)]
    public void Circle_Queue_KeepsTheStoredAndContractCircle(AccessQueue queue, string stored, Identity.V1.GlobalRole contract)
    {
        AccessQueues.Circle(queue).ShouldBe(stored);
        AccessQueues.ContractCircle(queue).ShouldBe(contract);
    }
}
