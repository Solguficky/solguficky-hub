namespace AppHost.Configuration.Topology;

/// <summary>
/// Чем узел становится в чарте (ADR-055). Отображение — обязательный аргумент
/// регистрации: узел без него не компилируется, а исключённый узел несёт
/// причину строкой в Program.cs, поэтому выпадение из чарта видно в диффе, а не
/// обнаруживается на кластере.
/// </summary>
internal abstract class PublishMapping
{
    private PublishMapping()
    {
    }

    /// <summary>
    /// Сервис становится workload'ом чарта. Setup строит его из образа, а не из
    /// исходников: служебных узлов сборки в публикации нет.
    /// </summary>
    public static PublishMapping Workload<T>(Func<ServiceGraphContext, IResourceBuilder<T>> configure)
        where T : class, IComputeResource =>
        new WorkloadMapping(context => configure(context));

    /// <summary>
    /// Инфраструктура остаётся вне чарта: setup публикует в контексте строки
    /// подключения под теми же именами, что и локальные ресурсы, и ссылки
    /// сервисов на них не меняются. Значения даёт среда кластера.
    /// </summary>
    public static PublishMapping Connections(Action<ServiceGraphContext> publish) =>
        new ConnectionsMapping(publish);

    /// <summary>
    /// Узел в чарт не входит. Профиль публикации, который им владеет, граф
    /// отвергает с этой причиной.
    /// </summary>
    public static PublishMapping NotPublished(string reason) => new NotPublishedMapping(reason);

    internal sealed class WorkloadMapping(Func<ServiceGraphContext, IResourceBuilder<IComputeResource>> configure)
        : PublishMapping
    {
        public IResourceBuilder<IComputeResource> Configure(ServiceGraphContext context) => configure(context);
    }

    internal sealed class ConnectionsMapping(Action<ServiceGraphContext> publish) : PublishMapping
    {
        public void Publish(ServiceGraphContext context) => publish(context);
    }

    internal sealed class NotPublishedMapping(string reason) : PublishMapping
    {
        public string Reason { get; } = reason;
    }
}
