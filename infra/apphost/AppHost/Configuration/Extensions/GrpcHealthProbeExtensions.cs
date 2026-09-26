using Grpc.Health.V1;
using Grpc.Net.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace AppHost.Configuration.Extensions;

/// <summary>
/// Готовность gRPC-сервиса по стандартному <c>grpc.health.v1.Health/Check</c>.
/// Проба отвечает на вопрос «сервис обслуживает вызовы», а не «процесс живёт»:
/// прокси DCP принимает TCP раньше, чем сервер начинает слушать.
/// </summary>
internal static class GrpcHealthProbeExtensions
{
    // У пробы обязаны быть оба предела: deadline самого gRPC-вызова и timeout
    // всей проверки. Без них CheckAsync ждёт ответа бесконечно, цикл health молча
    // зависает, а `aspire wait` и любой WaitFor стоят без диагностики.
    private static readonly TimeSpan ProbeDeadline = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Вешает на ресурс health check, который ходит в его gRPC-endpoint.
    /// Имя проверки собирается из имени ресурса и endpoint-а, поэтому совпадает
    /// с тем, что показывает дашборд.
    /// </summary>
    public static IResourceBuilder<T> WithGrpcHealthProbe<T>(
        this IResourceBuilder<T> resource,
        string endpointName)
        where T : IResourceWithEndpoints
    {
        var resourceName = resource.Resource.Name;
        var checkName = $"{resourceName}-{endpointName}";
        var endpoint = resource.GetEndpoint(endpointName);

        resource.ApplicationBuilder.Services.AddHealthChecks().AddAsyncCheck(
            checkName,
            cancellationToken => CheckAsync(resourceName, endpoint, cancellationToken),
            timeout: ProbeTimeout);

        return resource.WithHealthCheck(checkName);
    }

    // Английский текст здесь не стилистика: stdout AppHost проходит через Aspire
    // CLI, который ломает не-ASCII.
    private static async Task<HealthCheckResult> CheckAsync(
        string resourceName,
        EndpointReference endpoint,
        CancellationToken cancellationToken)
    {
        try
        {
            var address = await endpoint.GetValueAsync(cancellationToken);
            if (string.IsNullOrWhiteSpace(address))
            {
                return HealthCheckResult.Unhealthy($"Aspire assigned no gRPC endpoint to '{resourceName}'.");
            }

            using var channel = GrpcChannel.ForAddress(address);
            var client = new Health.HealthClient(channel);
            var response = await client.CheckAsync(
                new HealthCheckRequest(),
                deadline: DateTime.UtcNow.Add(ProbeDeadline),
                cancellationToken: cancellationToken);

            return response.Status == HealthCheckResponse.Types.ServingStatus.Serving
                ? HealthCheckResult.Healthy()
                : HealthCheckResult.Unhealthy($"'{resourceName}' reported gRPC health status {response.Status}.");
        }
        catch (Exception exception)
        {
            // Отменённый токен — это остановка AppHost или сработавший timeout самой
            // проверки, а не отказ сервиса. gRPC отдаёт отмену как
            // RpcException(Cancelled), а health-инфраструктура отличает отмену от
            // падения проверки только по OperationCanceledException, поэтому отмена
            // перебрасывается ею. Без этого штатный стоп виден на дашборде как
            // Unhealthy с приложенным исключением.
            cancellationToken.ThrowIfCancellationRequested();
            return HealthCheckResult.Unhealthy($"gRPC health check of '{resourceName}' failed.", exception);
        }
    }
}
