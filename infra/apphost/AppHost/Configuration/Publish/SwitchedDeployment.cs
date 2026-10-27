using Aspire.Hosting.Kubernetes.Resources;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;
using YamlDotNet.Serialization;

namespace AppHost.Configuration.Publish;

/// <summary>
/// Deployment, число реплик которого задаёт ключ values среды. У генератора
/// <c>replicas</c> — число, а шаблон Helm в числовое поле не ложится: строку,
/// которая начинается с <c>{</c>, сериализатор YAML обязан взять в кавычки, и
/// Kubernetes не примет <c>replicas: "1"</c>, хотя <c>helm template</c> и
/// <c>helm lint</c> промолчат. Поэтому поле — явно типизированный скаляр
/// <c>!!int "…"</c>: Helm подставляет внутрь кавычек 0 или 1, а YAML-разборщики
/// Helm, kubectl и kustomize читают по тегу число (проверено на sigs.k8s.io/yaml
/// и yaml.v3).
/// </summary>
[YamlSerializable]
internal sealed class SwitchedDeployment() : Workload("apps/v1", "Deployment")
{
    [YamlMember(Alias = "spec")]
    public SwitchedDeploymentSpec Spec { get; set; } = new();

    public override PodTemplateSpecV1 PodTemplate => Spec.Template;

    /// <summary>
    /// Переносит то, что генератор и форма workload'а уже записали в Deployment,
    /// и заменяет только число реплик.
    /// </summary>
    public static SwitchedDeployment From(Deployment deployment, string valuesKey) =>
        new()
        {
            Metadata = deployment.Metadata,
            Spec = new SwitchedDeploymentSpec
            {
                Selector = deployment.Spec.Selector,
                Replicas = new SwitchedReplicas(valuesKey),
                RevisionHistoryLimit = deployment.Spec.RevisionHistoryLimit,
                Strategy = deployment.Spec.Strategy,
                Template = deployment.Spec.Template,
            },
        };
}

/// <summary>
/// <c>replicas</c> — последнее поле, и это правило. Скаляр пишется в emitter
/// мимо цепочки сериализатора генератора, которая ведёт счёт «ключ — значение»,
/// и ключи после него вышли бы в кавычках. YAML от этого не ломается, а правила
/// чарта на регулярных выражениях ломаются: <c>"strategy":</c> они не узнают.
/// </summary>
[YamlSerializable]
internal sealed class SwitchedDeploymentSpec
{
    [YamlMember(Alias = "selector", Order = 0)]
    public LabelSelectorV1 Selector { get; set; } = new();

    [YamlMember(Alias = "revisionHistoryLimit", Order = 1)]
    public int? RevisionHistoryLimit { get; set; }

    [YamlMember(Alias = "strategy", Order = 2)]
    public DeploymentStrategyV1 Strategy { get; set; } = new();

    [YamlMember(Alias = "template", Order = 3)]
    public PodTemplateSpecV1 Template { get; set; } = new();

    [YamlMember(Alias = "replicas", Order = 4)]
    public SwitchedReplicas Replicas { get; set; } = new(string.Empty);
}

/// <summary>
/// Одна реплика, когда в values среды стоит <c>enabled.&lt;сервис&gt;: true</c>, иначе
/// ноль. Генератор не умеет класть в values.yaml свои ключи, поэтому умолчание
/// «выключено» живёт в шаблоне, а <c>dig</c> по <c>.Values.AsMap</c> не падает на
/// отсутствующем <c>enabled</c>. Сравнение со строкой <c>true</c>, а не голый
/// <c>if</c>: строка <c>"false"</c> в values для <c>if</c> истинна.
/// </summary>
internal sealed class SwitchedReplicas(string valuesKey) : IYamlConvertible
{
    public const string ValuesSection = "enabled";

    public string Template { get; } =
        $"{{{{ if eq (toString (dig `{ValuesSection}` `{valuesKey}` false .Values.AsMap)) `true` }}}}1{{{{ else }}}}0{{{{ end }}}}";

    public void Read(IParser parser, Type expectedType, ObjectDeserializer nestedObjectDeserializer) =>
        throw new NotSupportedException("The chart is generated, never read back.");

    public void Write(IEmitter emitter, ObjectSerializer nestedObjectSerializer) =>
        emitter.Emit(new Scalar(
            anchor: AnchorName.Empty,
            tag: new TagName("tag:yaml.org,2002:int"),
            value: Template,
            style: ScalarStyle.DoubleQuoted,
            isPlainImplicit: false,
            isQuotedImplicit: false));
}
