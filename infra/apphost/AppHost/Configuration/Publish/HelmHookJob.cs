using Aspire.Hosting.Kubernetes.Resources;
using YamlDotNet.Serialization;

namespace AppHost.Configuration.Publish;

/// <summary>
/// Job, который генератор Aspire сам не строит: он публикует каждый compute-ресурс
/// Deployment'ом. Setup заменяет им workload ресурса и переносит в него шаблон
/// пода, который генератор уже заполнил образом, переменными и секретами.
/// </summary>
[YamlSerializable]
internal sealed class HelmHookJob() : Workload("batch/v1", "Job")
{
    [YamlMember(Alias = "spec")]
    public HelmHookJobSpec Spec { get; set; } = new();

    public override PodTemplateSpecV1 PodTemplate => Spec.Template;
}

[YamlSerializable]
internal sealed class HelmHookJobSpec
{
    [YamlMember(Alias = "backoffLimit")]
    public int BackoffLimit { get; set; }

    [YamlMember(Alias = "activeDeadlineSeconds")]
    public int ActiveDeadlineSeconds { get; set; }

    [YamlMember(Alias = "template")]
    public PodTemplateSpecV1 Template { get; set; } = new();
}

internal static class HelmHook
{
    /// <summary>
    /// Pre-hook, а не post: Notifications и боты без своего durable падают на
    /// старте, и с <c>helm --wait</c> post-hook ждал бы готовности подов, которые
    /// без него готовыми не станут. Pre-hook идёт до ресурсов релиза, поэтому
    /// ConfigMap и Secret самого Job — тоже hook'и, с весом раньше Job.
    /// </summary>
    public const string Events = "pre-install,pre-upgrade";

    public const string InputWeight = "-10";

    public const string JobWeight = "0";

    /// <summary>
    /// Прошлый объект удаляется перед созданием нового, а упавший Job остаётся
    /// до следующей выкладки: его лог — единственная улика.
    /// </summary>
    public const string DeletePolicy = "before-hook-creation";

    public static void Mark(BaseKubernetesResource resource, string weight)
    {
        resource.Metadata.Annotations["helm.sh/hook"] = Events;
        resource.Metadata.Annotations["helm.sh/hook-weight"] = weight;
        resource.Metadata.Annotations["helm.sh/hook-delete-policy"] = DeletePolicy;
    }
}
