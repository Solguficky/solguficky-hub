namespace Contour.Environment;

/// <summary>
/// Адреса контура наружу. Имена переменных — те же, что AppHost отдаёт боту,
/// поэтому потребитель не узнаёт, кто его поднял: PER-271 читает окружение и
/// средой не владеет. Полный состав того, что уходит потребителю, собирает
/// <see cref="ConsumerEnvironment"/>.
///
/// Auction в составе по запросу (<see cref="ContourOptions.WithAuction"/>):
/// без него адреса нет вовсе, а не пустая строка — потребитель, которому он
/// нужен, отказывает по имени переменной, как бот без <c>AUCTION_GRPC_URL</c>.
/// </summary>
public sealed record ContourEndpoints(Uri IdentityGrpcUrl, Uri MeetupsGrpcUrl, Uri? AuctionGrpcUrl = null)
{
    public const string IdentityVariable = "IDENTITY_GRPC_URL";
    public const string MeetupsVariable = "MEETUPS_GRPC_URL";
    public const string AuctionVariable = "AUCTION_GRPC_URL";

    public IReadOnlyDictionary<string, string> AsEnvironment()
    {
        var variables = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [IdentityVariable] = IdentityGrpcUrl.ToString(),
            [MeetupsVariable] = MeetupsGrpcUrl.ToString(),
        };

        if (AuctionGrpcUrl is not null)
        {
            variables[AuctionVariable] = AuctionGrpcUrl.ToString();
        }

        return variables;
    }
}
