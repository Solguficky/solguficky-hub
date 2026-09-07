using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Extensions;

/// <summary>
/// Привязка к зависимости по имени узла. Узла нет в этом запуске — хелпер
/// ничего не делает: компонент читает адрес из своего конфига, а AppHost не
/// переписывает его молча. Поэтому в setup нет ни одного <c>if (x is not null)</c>.
/// </summary>
internal static class ResourceBindExtensions
{
    /// <summary>
    /// Отдаёт компоненту endpoint зависимости под ключом, который он реально
    /// читает, и откладывает старт до её готовности.
    /// </summary>
    public static IResourceBuilder<T> BindEndpoint<T>(
        this IResourceBuilder<T> resource,
        ServiceGraphContext context,
        string dependency,
        string endpointName,
        string environmentKey)
        where T : IResourceWithEnvironment, IResourceWithWaitSupport
    {
        var target = context.Get<IResourceWithEndpoints>(dependency);
        if (target is null)
        {
            return resource;
        }

        return resource
            .WithEnvironment(environmentKey, target.GetEndpoint(endpointName))
            .WaitFor(target);
    }

    /// <summary>
    /// Отдаёт компоненту connection string зависимости. Выражение строит
    /// вызывающий: ключ и формат диктует компонент, а не конвенция AppHost.
    /// </summary>
    public static IResourceBuilder<T> BindConnection<T, TDependency>(
        this IResourceBuilder<T> resource,
        ServiceGraphContext context,
        string dependency,
        string environmentKey,
        Func<IResourceBuilder<TDependency>, ReferenceExpression> connectionString)
        where T : IResourceWithEnvironment, IResourceWithWaitSupport
        where TDependency : class, IResource
    {
        var target = context.Get<TDependency>(dependency);
        if (target is null)
        {
            return resource;
        }

        return resource
            .WithEnvironment(environmentKey, connectionString(target))
            .WaitFor(target);
    }
}
