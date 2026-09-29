using Aspire.Hosting.Kubernetes.Resources;

namespace AppHost.Configuration.Publish;

/// <summary>
/// Форма workload'а в чарте. Одна реплика и <c>Recreate</c> у всех четырёх
/// сервисов (ADR-055): Identity, Meetups и Notifications применяют миграции при
/// старте, а бот держит единственный poller на токен — два экземпляра
/// одновременно недопустимы даже на время выкатки.
/// </summary>
/// <param name="RunAsUser">UID пользователя образа: 1000 у Containerfile, 1654 у SDK-контейнера (Container.targets).</param>
/// <param name="Grpc">Порт и имя readiness-сервиса для gRPC-проб; <c>null</c> — у сервиса нет health-эндпоинта.</param>
internal sealed record ClusterWorkload(
    long RunAsUser,
    string CpuRequest,
    string MemoryRequest,
    string CpuLimit,
    string MemoryLimit,
    GrpcProbe? Grpc);

/// <summary>Пустое имя — liveness, имя сервиса — readiness с базой (ADR-054).</summary>
internal sealed record GrpcProbe(int Port, string ReadinessService);

internal static class ClusterWorkloadExtensions
{
    public static IResourceBuilder<T> AsClusterWorkload<T>(this IResourceBuilder<T> resource, ClusterWorkload shape)
        where T : IComputeResource =>
        resource.PublishAsKubernetesService(kubernetes =>
        {
            var deployment = kubernetes.Workload as Deployment
                ?? throw new InvalidOperationException(
                    $"'{resource.Resource.Name}' is published as {kubernetes.Workload?.GetType().Name ?? "nothing"}, expected a Deployment.");

            deployment.Spec.Replicas = 1;
            // Генератор заполняет rollingUpdate и при Recreate, а такой Deployment
            // API Kubernetes отвергает — helm template этого не видит.
            deployment.Spec.Strategy = new DeploymentStrategyV1 { Type = "Recreate", RollingUpdate = null! };

            var pod = deployment.Spec.Template.Spec;
            pod.SecurityContext = new PodSecurityContextV1
            {
                RunAsNonRoot = true,
                RunAsUser = shape.RunAsUser,
                RunAsGroup = shape.RunAsUser,
                SeccompProfile = new SeccompProfileV1 { Type = "RuntimeDefault" },
            };

            foreach (var container in pod.Containers)
            {
                container.SecurityContext = new SecurityContextV1
                {
                    AllowPrivilegeEscalation = false,
                    Capabilities = new CapabilitiesV1 { Drop = { "ALL" } },
                };

                container.Resources = new ResourceRequirementsV1
                {
                    Requests = { ["cpu"] = shape.CpuRequest, ["memory"] = shape.MemoryRequest },
                    Limits = { ["cpu"] = shape.CpuLimit, ["memory"] = shape.MemoryLimit },
                };

                if (shape.Grpc is { } grpc)
                {
                    // Сервисы применяют миграции при старте, Notifications — ещё и до
                    // подъёма силоса. Пока startup-проба не прошла, liveness не
                    // спрашивается: иначе долгая миграция упёрлась бы в 30 секунд
                    // liveness и под перезапускался бы посреди неё по кругу.
                    container.StartupProbe = GrpcProbe(grpc.Port, string.Empty, periodSeconds: 5, failureThreshold: 60);
                    container.LivenessProbe = GrpcProbe(grpc.Port, string.Empty);
                    container.ReadinessProbe = GrpcProbe(grpc.Port, grpc.ReadinessService);
                }
            }
        });

    // Сервис считает готовность не дольше 2 секунд (ADR-054), поэтому таймаут
    // пробы в 3 секунды оставляет запас на сам вызов — как deadline локальной
    // пробы AppHost.
    private static ProbeV1 GrpcProbe(int port, string service, int periodSeconds = 10, int failureThreshold = 3) => new()
    {
        Grpc = new GrpcActionV1 { Port = port, Service = service },
        PeriodSeconds = periodSeconds,
        TimeoutSeconds = 3,
        FailureThreshold = failureThreshold,
    };
}
