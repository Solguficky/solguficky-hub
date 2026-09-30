using AppHost.Configuration.Models;

namespace AppHost.Configuration.Topology;

/// <summary>
/// То, что setup знает о запуске: builder, профиль и уже материализованные узлы.
/// Имя профиля setup не читает — он спрашивает граф, есть ли ресурс.
/// </summary>
internal sealed class ServiceGraphContext(
    IDistributedApplicationBuilder builder,
    ProfileConfig profile)
{
    private readonly Dictionary<string, object> _resolved = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, IResourceBuilder<ParameterResource>> _serviceTokens = new(StringComparer.OrdinalIgnoreCase);

    public IDistributedApplicationBuilder Builder { get; } = builder;

    public ProfileConfig Profile { get; } = profile;

    /// <summary>
    /// Публикует ресурс, которым setup владеет внутри себя: базу внутри сервера,
    /// endpoint внутри контейнера. Такие узлы не перечисляются в профиле и не
    /// попадают в <c>depends</c> — их жизненный цикл принадлежит владельцу.
    /// </summary>
    public void Publish<T>(string name, IResourceBuilder<T> resource) where T : IResource =>
        _resolved[name] = resource;

    public bool Has(string name) => _resolved.ContainsKey(name);

    /// <summary>
    /// Ресурс, если он материализован в этом запуске, иначе <c>null</c>.
    /// Несовпадение типа — ошибка графа, а не отсутствие ресурса.
    /// </summary>
    public IResourceBuilder<T>? Get<T>(string name) where T : IResource
    {
        if (!_resolved.TryGetValue(name, out var value))
        {
            return null;
        }

        return value as IResourceBuilder<T>
            ?? throw new InvalidOperationException(
                $"Node '{name}' is {value.GetType().Name}, expected IResourceBuilder<{typeof(T).Name}>.");
    }

    internal void Set(string name, object resource) => _resolved[name] = resource;

    /// <summary>
    /// Секрет вызывающего (ADR-056): один параметр на вызывающего, сколько бы
    /// сторон на него ни ссылалось, — так вызывающий и каждый его вызываемый
    /// получают одно значение по построению, а не по совпадению. Параметр
    /// заводит первая обратившаяся сторона: узел вызывающего в запуске для
    /// этого не нужен.
    /// </summary>
    public IResourceBuilder<ParameterResource> ServiceToken(string caller)
    {
        if (!_serviceTokens.TryGetValue(caller, out var token))
        {
            token = CreateServiceToken($"{caller}-service-token");
            _serviceTokens[caller] = token;
        }

        return token;
    }

    // Значение генерирует Aspire только в run: `aspire run` не просит ввода, а
    // перезапуск меняет токен у обеих сторон разом. В publish параметр остаётся
    // без значения, как maintainer-секрет: сгенерированное значение легло бы в
    // values.yaml чарта, а секреты прода ведёт ops-инвентарь (PER-372).
    private IResourceBuilder<ParameterResource> CreateServiceToken(string name) =>
        Builder.ExecutionContext.IsRunMode
            ? Builder.AddParameter(name, new GenerateParameterDefault { MinLength = 32, Special = false }, secret: true)
            : Builder.AddParameter(name, secret: true);
}
