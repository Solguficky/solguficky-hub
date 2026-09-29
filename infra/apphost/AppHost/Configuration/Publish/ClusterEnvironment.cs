using Aspire.Hosting.Kubernetes;

namespace AppHost.Configuration.Publish;

/// <summary>
/// Среда чарта прода (ADR-055): k3s, в который Flux ставит OCI-чарт из GHCR.
/// Namespace и имя релиза здесь не задаются — их выбирает HelmRelease среды в
/// ops-репозитории, и один чарт ставится в test и prod.
/// </summary>
internal static class ClusterEnvironment
{
    public const string Name = "k8s";
    public const string ChartName = "solguficky-hub";

    // Версию чарта в GHCR задаёт CI при упаковке; здесь — версия, с которой чарт
    // собирается локально и в проверке на PR.
    public const string ChartVersion = "0.1.0";

    public static void Configure(IDistributedApplicationBuilder builder) =>
        builder.AddKubernetesEnvironment(Name)
            .WithHelm(helm => helm
                .WithChartName(ChartName)
                .WithChartVersion(ChartVersion)
                .WithChartDescription("Solguficky Hub: Identity, Meetups, Notifications and Telegram Bot"))
            // Дашборд Aspire стал бы пятым workload'ом с доступом к телеметрии всех
            // сервисов; телеметрия прода идёт через Collector (ADR-053).
            .WithProperties(environment => environment.DashboardEnabled = false);
}
