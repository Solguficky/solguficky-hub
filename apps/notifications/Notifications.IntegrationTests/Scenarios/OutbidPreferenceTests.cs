using Grpc.Core;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>Чтение и запись настройки перебитий через настоящую границу сервиса (PER-514).</summary>
public class OutbidPreferenceTests
{
    [Fact]
    public async Task When_PersonNeverSetFrequency_Expect_EveryOutbid()
    {
        await using var service = await PreferencesUnderTest.Start();
        var identityId = Guid.CreateVersion7().ToString("D");

        var preference = await service.Client.GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId });

        preference.IdentityId.ShouldBe(identityId);
        preference.Frequency.ShouldBe(OutbidFrequency.Every);
    }

    [Fact]
    public async Task When_FrequencySetTwice_Expect_LastValueAnsweredAndRead()
    {
        await using var service = await PreferencesUnderTest.Start();
        var identityId = Guid.CreateVersion7().ToString("D");

        await service.Client.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest
        {
            IdentityId = identityId,
            Frequency = OutbidFrequency.Off,
        });
        var answered = await service.Client.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest
        {
            IdentityId = identityId,
            Frequency = OutbidFrequency.AtMostEvery15Minutes,
        });
        var read = await service.Client.GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId });

        answered.Frequency.ShouldBe(OutbidFrequency.AtMostEvery15Minutes);
        read.ShouldBe(answered);
    }

    [Fact]
    public async Task When_FrequencyUnspecified_Expect_InvalidArgumentAndNothingStored()
    {
        await using var service = await PreferencesUnderTest.Start();
        var identityId = Guid.CreateVersion7().ToString("D");

        var declined = await Should.ThrowAsync<RpcException>(async () =>
            await service.Client.SetOutbidPreferenceAsync(new SetOutbidPreferenceRequest { IdentityId = identityId }));

        declined.StatusCode.ShouldBe(StatusCode.InvalidArgument);
        (await service.Client.GetOutbidPreferenceAsync(new GetOutbidPreferenceRequest { IdentityId = identityId }))
            .Frequency.ShouldBe(OutbidFrequency.Every);
    }
}
