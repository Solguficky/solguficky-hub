namespace Contour.Environment;

/// <summary>
/// Адреса контура наружу. Имена переменных — те же, что AppHost отдаёт боту,
/// поэтому потребитель не узнаёт, кто его поднял: PER-271 читает окружение и
/// средой не владеет. Полный состав того, что уходит потребителю, собирает
/// <see cref="ConsumerEnvironment"/>.
/// </summary>
public sealed record ContourEndpoints(Uri IdentityGrpcUrl, Uri MeetupsGrpcUrl)
{
    public const string IdentityVariable = "IDENTITY_GRPC_URL";
    public const string MeetupsVariable = "MEETUPS_GRPC_URL";

    public IReadOnlyDictionary<string, string> AsEnvironment() =>
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [IdentityVariable] = IdentityGrpcUrl.ToString(),
            [MeetupsVariable] = MeetupsGrpcUrl.ToString(),
        };
}
