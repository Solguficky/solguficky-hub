using Contour.Environment;
using Grpc.Core;
using Grpc.Net.Client;
using Identity.V1;
using Meetups.V1;
using Xunit;

namespace Contour.E2ETests.Infrastructure;

/// <summary>
/// Один подъём контура на всю сборку: топология стоит дороже любого теста, а
/// сценарий здесь всего один. Коллекция запрещает параллельный прогон — два
/// инстанса делили бы порты, контейнер и базу.
/// </summary>
public sealed class ContourFixture : IAsyncLifetime
{
    private ContourHost? contour;

    public ContourHost Contour => contour
        ?? throw new InvalidOperationException("фикстура не инициализирована");

    public GrpcChannel IdentityChannel { get; private set; } = null!;

    public GrpcChannel MeetupsChannel { get; private set; } = null!;

    public IdentityService.IdentityServiceClient IdentityClient => new(IdentityChannel);

    public MeetupsService.MeetupsServiceClient MeetupsClient => new(MeetupsChannel);

    /// <summary>Метаданные maintainer: без них Identity отвечает Unauthenticated.</summary>
    public Metadata MaintainerCall() =>
        new() { { "authorization", $"Bearer {Contour.MaintainerToken}" } };

    public async ValueTask InitializeAsync()
    {
        contour = await ContourHost.StartAsync(TestContext.Current.CancellationToken);

        IdentityChannel = GrpcChannel.ForAddress(Contour.Endpoints.IdentityGrpcUrl);
        MeetupsChannel = GrpcChannel.ForAddress(Contour.Endpoints.MeetupsGrpcUrl);
    }

    public async ValueTask DisposeAsync()
    {
        IdentityChannel?.Dispose();
        MeetupsChannel?.Dispose();

        if (contour is not null)
        {
            await contour.DisposeAsync();
        }
    }
}

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ContourCollection : ICollectionFixture<ContourFixture>
{
    public const string Name = "contour";
}
