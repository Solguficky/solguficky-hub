using System.Net;
using System.Net.Sockets;

namespace Notifications;

/// <summary>
/// Где силос живёт в кластере: под каким адресом он записывает себя в
/// membership, на каком интерфейсе слушает и к какому кластеру и сервису
/// принадлежит.
/// </summary>
/// <remarks>
/// Логический силос Orleans — это объявленный адрес. Поднявшийся силос сам
/// закрывает неснятую запись предшественника, только если объявляет тот же
/// адрес; на другом адресе он пять минут ждёт ответа от покойника и падает с
/// <c>OrleansClusterConnectivityCheckFailedException</c>. Поэтому в развёртывании
/// силос объявляет не адрес пода, который меняется при каждом пересоздании, а
/// постоянный адрес Service. Корректность этого держится на инварианте «силос
/// один на среду»: второго силоса под тем же адресом быть не может, и
/// объявленный адрес никто не набирает.
/// <para>
/// Слушает силос в поде петлю, а не интерфейсы пода. Свой объявленный адрес он
/// не набирает: вызовы внутри силоса и co-hosted клиента идут мимо сети. Других
/// силосов в среде нет, поэтому входящие соединения на порты силоса и gateway
/// ему не нужны, а интерфейсы пода открыли бы их соседям по сети кластера.
/// Service нужен только ради постоянного адреса, публиковать эти порты ему не нужно.
/// </para>
/// </remarks>
public sealed record SiloPlacement(
    string ClusterId,
    string ServiceId,
    IPAddress AdvertisedAddress,
    IPAddress? ListeningAddress)
{
    /// <summary>
    /// Kubernetes задаёт её в каждом поде сам, поэтому режим развёртывания нельзя
    /// забыть включить в чарте.
    /// </summary>
    public const string KubernetesVariable = "KUBERNETES_SERVICE_HOST";

    /// <summary>Постоянное имя или адрес, под которым силос объявляет себя в membership.</summary>
    public const string AdvertisedHostVariable = "NOTIFICATIONS_SILO_ADVERTISED_HOST";

    /// <summary>Кластер среды: разный у теста и прода, общий для всех запусков одной среды.</summary>
    public const string ClusterIdVariable = "NOTIFICATIONS_CLUSTER_ID";

    /// <summary>
    /// Сервис среды. Ключует таблицу reminders Orleans, поэтому у живой среды не
    /// меняется: новый ServiceId оставил бы её reminders без владельца.
    /// </summary>
    public const string ServiceIdVariable = "NOTIFICATIONS_SERVICE_ID";

    private static readonly string[] DeploymentVariables = [AdvertisedHostVariable, ClusterIdVariable, ServiceIdVariable];

    /// <summary>
    /// Локальный запуск: Aspire поднимает сервис процессом на машине, и силос
    /// объявляет петлю — адрес LAN из membership пережил бы рестарт и указывал
    /// бы на чужой интерфейс. Слушает он там же, где объявлен.
    /// </summary>
    public static SiloPlacement Local { get; } =
        new(NotificationsHost.ClusterId, NotificationsHost.ServiceId, IPAddress.Loopback, ListeningAddress: null);

    /// <summary>
    /// Расположение из окружения. Развёртывание распознаётся по
    /// <see cref="KubernetesVariable" /> или по любой из своих переменных, и тогда
    /// обязательны все три: силос в поде не стартует с локальными умолчаниями, а
    /// падает с именем недостающей переменной.
    /// </summary>
    /// <param name="resolve">
    /// Разрешение имени в адреса. Параметр, а не вызов <see cref="Dns" />: разбор
    /// остаётся чистой функцией, и unit-тест не зависит от DNS машины.
    /// </param>
    public static SiloPlacement FromEnvironment(Func<string, string?> environment, Func<string, IPAddress[]> resolve)
    {
        var deployed = !string.IsNullOrWhiteSpace(environment(KubernetesVariable))
            || DeploymentVariables.Any(name => !string.IsNullOrWhiteSpace(environment(name)));

        if (!deployed)
        {
            return Local;
        }

        var host = Required(environment, AdvertisedHostVariable);
        var clusterId = Required(environment, ClusterIdVariable);
        var serviceId = Required(environment, ServiceIdVariable);

        return new SiloPlacement(clusterId, serviceId, Resolve(host, resolve), IPAddress.Loopback);
    }

    private static string Required(Func<string, string?> environment, string name)
    {
        var value = environment(name);

        // Обрезка, а не значение как есть: «prod » с хвостовым пробелом из
        // values ушло бы в deploymentid отдельным кластером.
        return string.IsNullOrWhiteSpace(value)
            ? throw new InvalidOperationException($"{name} is not set")
            : value.Trim();
    }

    /// <summary>
    /// Адрес разрешается один раз, при старте: membership хранит адрес, а не
    /// имя, и переразрешать его на ходу Orleans не умеет. ClusterIP Service
    /// постоянен на всю жизнь Service, поэтому одного разрешения достаточно.
    /// </summary>
    private static IPAddress Resolve(string host, Func<string, IPAddress[]> resolve)
    {
        // Литералом считается только запись из четырёх октетов: TryParse
        // принимает и «1234» как 0.0.4.210, и IPv6, а силос объявляет IPv4.
        // Остальное разрешается как имя и проходит ту же проверку семейства.
        if (host.Count(c => c == '.') == 3
            && IPAddress.TryParse(host, out var literal)
            && literal.AddressFamily == AddressFamily.InterNetwork)
        {
            return literal;
        }

        IPAddress[] addresses;

        try
        {
            addresses = resolve(host);
        }
        catch (Exception ex) when (ex is SocketException or ArgumentException)
        {
            throw new InvalidOperationException($"{AdvertisedHostVariable} cannot be resolved: {host}: {ex.Message}", ex);
        }

        return addresses.FirstOrDefault(address => address.AddressFamily == AddressFamily.InterNetwork)
            ?? throw new InvalidOperationException($"{AdvertisedHostVariable} has no IPv4 address: {host}");
    }
}
