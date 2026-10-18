using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;
using Aspire.Hosting.Kubernetes.Resources;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using NATS.Client.Core;
using NATS.Client.JetStream;

namespace AppHost.Configuration.Infrastructure;

internal static class NatsSetup
{
    public static IResourceBuilder<NatsServerResource> Configure(ServiceGraphContext context)
    {
        var volume = DataVolumes.Name(context.Builder, "nats-data");

        return context.Builder
            .AddNats(AppHostNames.Resources.Nats)
            .WithImageTag("2.10-alpine")
            .WithJetStream()
            // Без тома рестарт контейнера молча стирает стримы и позиции durable,
            // а outbox к тому моменту уже отметил события отправленными.
            .WithDataVolume(volume)
            // WaitFor(nats) ждёт не только Healthy, но и завершения обработчиков
            // ResourceReadyEvent: потребитель стартует, когда топология уже есть,
            // а упавшее применение роняет его ожидание. Пока ни один узел nats не
            // ждёт, сбой виден только в логе самого узла — поэтому он там пишется.
            .OnResourceReady((nats, readyEvent, cancellationToken) =>
                ApplyTopologyAsync(nats, readyEvent, volume, cancellationToken));
    }

    /// <summary>
    /// В чарте NATS — строка подключения среды под тем же именем. Топологию
    /// JetStream хук AppHost в кластере не создаёт: её применяет Helm-hook Job
    /// чарта из той же таблицы <see cref="JetStreamTopology"/> (PER-311).
    /// </summary>
    public static void Publish(ServiceGraphContext context)
    {
        var nats = context.Builder.AddConnectionString(AppHostNames.Resources.Nats);
        context.Publish(AppHostNames.Resources.Nats, nats);
        context.PublishHook(TopologyJob(context, nats));
    }

    // Имя ресурса и префикс его объектов в чарте. Узлом графа Job не является:
    // им владеет публикация NATS, профиль его не перечисляет.
    public const string TopologyJobName = "jetstream-topology";

    // nats-box со своим UID 1000: PSS restricted не пускает root. Тег назван для
    // чтения, решает digest — индекс мультиархитектурного образа.
    private const string NatsBoxImage = "natsio/nats-box";
    private const string NatsBoxTag = "0.20.0-nonroot";
    private const string NatsBoxDigest = "be25666441c3aee65193aba33d60ff2f06ede7ee9eba58864324b33d7eb94fea";
    private const long NatsBoxUser = 1000;

    private const string TopologyMount = "/topology";

    private static IResourceBuilder<ContainerResource> TopologyJob(
        ServiceGraphContext context,
        IResourceBuilder<IResourceWithConnectionString> nats) =>
        context.Builder
            .AddContainer(TopologyJobName, NatsBoxImage, NatsBoxTag)
            .WithImageRegistry("docker.io")
            .WithImageSHA256(NatsBoxDigest)
            .WithEntrypoint("/bin/sh")
            .WithArgs($"{TopologyMount}/{JetStreamTopologyScript.ScriptKey}", TopologyMount)
            // Адрес сервера nats CLI берёт из NATS_URL сам.
            .WithEnvironment("NATS_URL", nats)
            .PublishAsKubernetesService(kubernetes =>
            {
                var deployment = kubernetes.Workload as Deployment
                    ?? throw new InvalidOperationException(
                        $"'{TopologyJobName}' is published as {kubernetes.Workload?.GetType().Name ?? "nothing"}, expected a Deployment to convert.");

                var files = new ConfigMap();
                files.Metadata.Name = $"{TopologyJobName}-files";
                foreach (var (key, content) in JetStreamTopologyScript.Files())
                {
                    files.Data[key] = content;
                }

                var pod = deployment.Spec.Template.Spec;
                pod.RestartPolicy = "Never";
                pod.SecurityContext = new PodSecurityContextV1
                {
                    RunAsNonRoot = true,
                    RunAsUser = NatsBoxUser,
                    RunAsGroup = NatsBoxUser,
                    SeccompProfile = new SeccompProfileV1 { Type = "RuntimeDefault" },
                };
                pod.Volumes.Add(new VolumeV1
                {
                    Name = "topology",
                    ConfigMap = new ConfigMapVolumeSourceV1 { Name = files.Metadata.Name },
                });

                foreach (var container in pod.Containers)
                {
                    container.SecurityContext = new SecurityContextV1
                    {
                        AllowPrivilegeEscalation = false,
                        Capabilities = new CapabilitiesV1 { Drop = { "ALL" } },
                    };
                    // Квота namespace требует лимиты у каждого контейнера, и hook
                    // идёт, пока поды прошлой версии ещё живы.
                    container.Resources = new ResourceRequirementsV1
                    {
                        Requests = { ["cpu"] = "20m", ["memory"] = "16Mi" },
                        Limits = { ["cpu"] = "200m", ["memory"] = "64Mi" },
                    };
                    container.VolumeMounts.Add(new VolumeMountV1 { Name = "topology", MountPath = TopologyMount, ReadOnly = true });
                }

                var job = new HelmHookJob { Metadata = deployment.Metadata };
                job.Metadata.Name = TopologyJobName;
                job.Spec.BackoffLimit = 2;
                job.Spec.ActiveDeadlineSeconds = 300;
                job.Spec.Template = deployment.Spec.Template;
                HelmHook.Mark(job, HelmHook.JobWeight);
                kubernetes.Workload = job;

                HelmHook.Mark(files, HelmHook.InputWeight);
                kubernetes.AdditionalResources.Add(files);
                foreach (var input in new BaseKubernetesResource?[] { kubernetes.ConfigMap, kubernetes.Secret })
                {
                    if (input is not null)
                    {
                        HelmHook.Mark(input, HelmHook.InputWeight);
                    }
                }
            });

    private static async Task ApplyTopologyAsync(
        NatsServerResource nats,
        ResourceReadyEvent readyEvent,
        string volume,
        CancellationToken cancellationToken)
    {
        var logger = readyEvent.Services.GetRequiredService<ResourceLoggerService>().GetLogger(nats);
        var url = await nats.ConnectionStringExpression.GetValueAsync(cancellationToken)
            ?? throw new InvalidOperationException($"Aspire assigned no connection string to '{nats.Name}'.");

        await using var connection = new NatsConnection(new NatsOpts { Url = url });
        try
        {
            await JetStreamTopology.ApplyAsync(new NatsJSContext(connection), cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogError(
                exception,
                "JetStream topology was not applied. A change JetStream refuses on a live stream or consumer " +
                "needs the volume '{volume}' removed.",
                volume);
            throw;
        }

        logger.LogInformation(
            "JetStream topology applied: streams {Streams}; durable consumers {Durables}; key-value buckets {Buckets}.",
            string.Join(", ", JetStreamTopology.Streams.Select(stream => stream.Name)),
            string.Join(", ", JetStreamTopology.Durables.Select(durable => durable.Durable)),
            string.Join(", ", JetStreamTopology.KeyValueBuckets.Select(bucket => bucket.Bucket)));
    }
}
