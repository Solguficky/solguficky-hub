namespace AppHost.Configuration.Extensions;

internal static class ResourceBuilderExtensions
{
    /// <summary>
    /// Условное звено цепочки: не разрывает fluent-запись ради одного <c>if</c>.
    /// </summary>
    public static IResourceBuilder<T> ApplyIf<T>(
        this IResourceBuilder<T> resource,
        bool condition,
        Func<IResourceBuilder<T>, IResourceBuilder<T>> apply)
        where T : IResource
        => condition ? apply(resource) : resource;
}
