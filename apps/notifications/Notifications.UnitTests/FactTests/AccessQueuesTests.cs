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
    [InlineData(AccessQueue.Community, "manage_members")]
    [InlineData(AccessQueue.Auction, "admit_bidders")]
    public void ModeratorRight_Queue_IsTheRightThatDecidesIt(AccessQueue queue, string right) =>
        AccessQueues.ModeratorRight(queue).ShouldBe(right);

    [Theory]
    [InlineData(AccessQueue.Community, "access_hub")]
    [InlineData(AccessQueue.Auction, "place_bids")]
    public void AdmissionRight_Queue_IsTheRightItsAdmissionGrants(AccessQueue queue, string right) =>
        AccessQueues.AdmissionRight(queue).ShouldBe(right);

    [Theory]
    [InlineData(AccessQueue.Community, "member", Identity.V1.ApplicationQueue.Community)]
    [InlineData(AccessQueue.Auction, "public", Identity.V1.ApplicationQueue.Auction)]
    public void Circle_Queue_KeepsTheStoredKeyAndContractQueue(AccessQueue queue, string stored, Identity.V1.ApplicationQueue contract)
    {
        AccessQueues.Circle(queue).ShouldBe(stored);
        AccessQueues.ContractQueue(queue).ShouldBe(contract);
    }

    [Fact]
    public void ContractQueue_UnknownQueue_Throws() =>
        Should.Throw<ArgumentOutOfRangeException>(() => AccessQueues.ContractQueue((AccessQueue)99));
}
