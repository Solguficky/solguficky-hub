using Aspire.Hosting.Kubernetes.Resources;

namespace AppHost.Configuration.Publish;

/// <summary>
/// Форма workload'а в чарте. Одна реплика и <c>Recreate</c> у всех сервисов
/// (ADR-055): Identity, Meetups, Notifications и Auction применяют миграции при
/// старте, Auction ещё и держит одноузловой кластер, а бот — единственный poller
/// на токен; два экземпляра одновременно недопустимы даже на время выкатки.
/// </summary>
/// <param name="RunAsUser">UID пользователя образа: 1000 у Containerfile, 1654 у SDK-контейнера (Container.targets).</param>
/// <param name="Probe">Пробы сервиса; <c>null</c> — у сервиса нет health-эндпоинта.</param>
internal sealed record ClusterWorkload(
    long RunAsUser,
    string CpuRequest,
    string MemoryRequest,
    string CpuLimit,
    string MemoryLimit,
    WorkloadProbe? Probe);

internal abstract record WorkloadProbe;

/// <summary>Пустое имя — liveness, имя сервиса — readiness с базой (ADR-054).</summary>
internal sealed record GrpcProbe(int Port, string ReadinessService) : WorkloadProbe;

/// <summary>
/// Readiness — HTTP-путь, который отвечает готовностью с базой (Auction, <c>/health</c>).
/// Startup и liveness — TCP-подключение к тому же порту: путь готовности отвечает
/// 503 при недоступной базе, и проба на нём перезапускала бы под по кругу, пока
/// база лежит. Аналог пустого имени сервиса у gRPC-пробы. Порт Auction слушает
/// только после миграции и join кластера, поэтому TCP-startup их и ждёт.
/// </summary>
internal sealed record HttpProbe(int Port, string ReadinessPath) : WorkloadProbe;

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

                // Сервисы применяют миграции при старте, Notifications — ещё и до
                // подъёма силоса, Auction — до старта кластера. Пока startup-проба
                // не прошла, liveness не спрашивается: иначе долгая миграция
                // упёрлась бы в 30 секунд liveness и под перезапускался бы посреди
                // неё по кругу.
                switch (shape.Probe)
                {
                    case GrpcProbe grpc:
                        container.StartupProbe = Timed(new() { Grpc = new() { Port = grpc.Port, Service = string.Empty } }, periodSeconds: 5, failureThreshold: 60);
                        container.LivenessProbe = Timed(new() { Grpc = new() { Port = grpc.Port, Service = string.Empty } });
                        container.ReadinessProbe = Timed(new() { Grpc = new() { Port = grpc.Port, Service = grpc.ReadinessService } });
                        break;
                    case HttpProbe http:
                        container.StartupProbe = Timed(new() { TcpSocket = new() { Port = http.Port } }, periodSeconds: 5, failureThreshold: 60);
                        container.LivenessProbe = Timed(new() { TcpSocket = new() { Port = http.Port } });
                        container.ReadinessProbe = Timed(new() { HttpGet = new() { Port = http.Port, Path = http.ReadinessPath } });
                        break;
                }
            }
        });

    // Сервис считает готовность не дольше 2 секунд (ADR-054), поэтому таймаут
    // пробы в 3 секунды оставляет запас на сам вызов — как deadline локальной
    // пробы AppHost. Auction укладывается в тот же предел (readiness-timeout).
    private static ProbeV1 Timed(ProbeV1 probe, int periodSeconds = 10, int failureThreshold = 3)
    {
        probe.PeriodSeconds = periodSeconds;
        probe.TimeoutSeconds = 3;
        probe.FailureThreshold = failureThreshold;
        return probe;
    }
}
