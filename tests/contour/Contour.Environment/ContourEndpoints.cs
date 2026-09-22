namespace Contour.Environment;

/// <summary>
/// Адреса контура наружу. Имена переменных — те же, что AppHost отдаёт боту,
/// поэтому потребитель не узнаёт, кто его поднял: PER-271 читает окружение и
/// средой не владеет.
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

    /// <summary>
    /// Ровно две строки и ничего больше. В частности, сюда не попадает
    /// OTEL_EXPORTER_OTLP_ENDPOINT: PER-271 требует чистого окружения, и
    /// дешевле не отдавать лишнего, чем вычищать его на той стороне.
    /// </summary>
    public async Task WriteDotenvAsync(string path, CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(path));
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var lines = AsEnvironment().Select(pair => $"{pair.Key}={pair.Value}");
        await File.WriteAllLinesAsync(path, lines, cancellationToken);
    }
}
