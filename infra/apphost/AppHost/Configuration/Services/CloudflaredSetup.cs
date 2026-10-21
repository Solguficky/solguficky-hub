using System.Security.Cryptography;
using System.Text;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;
using Aspire.Hosting.Kubernetes.Resources;

namespace AppHost.Configuration.Services;

/// <summary>
/// Публичный вход в кластер — Cloudflare Tunnel только к маршрутам экрана зала
/// (ADR-071). Узел живёт только в чарте: в <c>aspire run</c> экран открывается по
/// адресу, который публикует Aspire, и туннель не поднимается.
/// </summary>
internal static class CloudflaredSetup
{
    // Публичный образ Cloudflare по digest индекса (ADR-055): тег — для чтения
    // человеком, тянется образ по digest. Пользователь образа — distroless
    // nonroot, entrypoint — `cloudflared --no-autoupdate`.
    private const string Image = "cloudflare/cloudflared";
    private const string Tag = "2026.9.3";
    private const string Digest = "072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c";
    private const long ImageUser = 65532;

    // Порт метрик cloudflared: `/ready` отвечает 200, пока есть соединение с
    // Cloudflare. Service у туннеля нет, порт нужен только пробам.
    private const int MetricsPort = 2000;
    private const string MetricsAddress = "0.0.0.0:2000";
    private const string ReadyPath = "/ready";

    private const string ConfigMount = "/etc/cloudflared";

    /// <summary>Имя ConfigMap с правилами — оно же имя файла шаблона в чарте.</summary>
    public const string IngressConfigMap = "cloudflared-ingress";

    // Startup и liveness — TCP на порт метрик, readiness — `/ready`: потерю
    // соединения cloudflared переживает сам переподключением, и рестарт пода
    // на ней ничего бы не дал.
    private static readonly ClusterWorkload Cluster = new(
        RunAsUser: ImageUser,
        CpuRequest: "10m",
        MemoryRequest: "32Mi",
        CpuLimit: "200m",
        MemoryLimit: "128Mi",
        Probe: new HttpProbe(MetricsPort, ReadyPath),
        Switched: true);

    /// <summary>
    /// Локального узла нет: туннелю без токена среды нечего делать на машине
    /// разработчика, а с токеном он открыл бы её экран в интернет. Профиль запуска
    /// узлом не владеет, и сюда приводит только явный <c>--profile cluster</c> или
    /// <c>--run-services cloudflared</c>.
    /// </summary>
    public static IResourceBuilder<ContainerResource> Configure(ServiceGraphContext context) =>
        throw new InvalidOperationException(
            $"'{AppHostNames.Resources.Cloudflared}' runs only in the cluster chart (ADR-071): "
                + "aspire run serves the hall screen on the address Aspire publishes.");

    /// <summary>
    /// Токен туннеля — секрет среды, разный в test и prod; cloudflared читает его
    /// из <c>TUNNEL_TOKEN</c>, поэтому в аргументах и спецификации пода его нет.
    /// Правила — ConfigMap чарта, смонтированный файлом: туннель управляется
    /// локально, и правила из дашборда Cloudflare он не берёт.
    /// </summary>
    public static IResourceBuilder<ContainerResource> Publish(ServiceGraphContext context)
    {
        var token = context.Builder.AddParameter("cloudflared-tunnel-token", secret: true);

        return context.Builder
            .AddContainer(AppHostNames.Resources.Cloudflared, Image, Tag)
            .WithImageRegistry("docker.io")
            .WithImageSHA256(Digest)
            .WithArgs("tunnel", "--config", $"{ConfigMount}/{TunnelIngress.FileName}", "run")
            .WithEnvironment("TUNNEL_TOKEN", token)
            .WithEnvironment("TUNNEL_METRICS", MetricsAddress)
            .AsClusterWorkload(Cluster)
            .PublishAsKubernetesService(kubernetes =>
            {
                var rules = new ConfigMap();
                rules.Metadata.Name = IngressConfigMap;
                rules.Data[TunnelIngress.FileName] = TunnelIngress.Config;
                kubernetes.AdditionalResources.Add(rules);

                var pod = kubernetes.Workload.PodTemplate;
                // Правка правил меняет шаблон пода, и Kubernetes перекатывает под:
                // смонтированный файл cloudflared перечитывает только на старте.
                pod.Metadata.Annotations["checksum/ingress"] = TunnelIngress.Checksum;
                pod.Spec.Volumes.Add(new VolumeV1
                {
                    Name = "ingress",
                    ConfigMap = new ConfigMapVolumeSourceV1 { Name = IngressConfigMap },
                });
                foreach (var container in pod.Spec.Containers)
                {
                    container.VolumeMounts.Add(new VolumeMountV1 { Name = "ingress", MountPath = ConfigMount, ReadOnly = true });
                }
            });
    }
}

/// <summary>
/// Правила туннеля (ADR-071): маршруты экрана Auction по префиксу пути, на
/// всё остальное — 404 от самого cloudflared, поэтому <c>/health</c> и gRPC
/// наружу не выходят ещё до кода Auction. Путь — регулярное выражение Go без
/// неявного якоря: без <c>^</c> правило пропустило бы <c>/x/screen/y</c>.
/// Имени хоста в правилах нет: домен — свойство среды, и правило одинаково
/// в test и prod. Адрес — Service Auction в namespace среды; совпадение с
/// отрисованным Service держит правило чарта (tools/apphost/check-chart.py).
/// </summary>
internal static class TunnelIngress
{
    public const string FileName = "config.yml";

    public const string ScreenPath = "^/screen/";

    public static readonly string Origin =
        $"http://{AppHostNames.Resources.Auction}-service:{AuctionSetup.ContainerHttpPort}";

    public static readonly string Config =
        $"""
        ingress:
          - path: {ScreenPath}
            service: {Origin}
          - service: http_status:404
        """ + "\n";

    public static readonly string Checksum =
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Config)));
}
