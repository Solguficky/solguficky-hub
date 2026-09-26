using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Connections;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>
/// Порты силоса и шлюза одного силоса под тестом.
/// </summary>
/// <remarks>
/// Штатные 11111 и 30000 тестам не годятся: второй силос того же теста и
/// соседнее рабочее дерево дерутся за них гарантированно. Поэтому порты
/// выдаются здесь, одним местом на процесс, по двум правилам.
///
/// Полоса лежит ниже эфемерного диапазона ОС: на Linux он начинается с 32768,
/// на Windows и macOS — с 49152. Порт, взятый из эфемерного диапазона и
/// отпущенный до старта силоса, ядро вправе отдать любому исходящему
/// соединению — пулу Npgsql, клиенту NATS, docker-proxy, — и силос падал с
/// <c>AddressInUseException</c>, которую аллокатор «не выдавать дважды» не
/// закрыл бы: соперник не аллокатор, а исходящий сокет. Ниже диапазона ядро
/// порт само не выдаёт, и занять его может только тот, кто биндит его явно.
///
/// Счётчик начинается со случайного места полосы: два прогона из соседних
/// рабочих деревьев, стартуя с одной базы, проверяли бы одни и те же номера в
/// одно время. Остаток гонки — проверка bind и старт силоса разнесены во
/// времени — закрывает повтор старта в <see cref="SiloUnderTest" /> и
/// <see cref="ServiceProcess" />, а не этот тип.
/// </remarks>
public sealed record SiloEndpoint(int SiloPort, int GatewayPort)
{
    /// <summary>
    /// Сколько раз старт силоса пробует свежую пару портов, прежде чем отдать
    /// отказ bind наружу.
    /// </summary>
    public const int LaunchAttempts = 3;

    private const int BandStart = 20000;
    private const int BandEnd = 32768;

    private static int cursor = Random.Shared.Next(BandEnd - BandStart);

    /// <summary>Аргументы командной строки хоста в форме <c>--Ключ=Значение</c>.</summary>
    public string[] Arguments =>
    [
        $"--{NotificationsHost.SiloPortKey}={SiloPort}",
        $"--{NotificationsHost.GatewayPortKey}={GatewayPort}",
    ];

    /// <summary>
    /// Отказ старта — это проигранная гонка за порт, а не дефект силоса.
    /// </summary>
    /// <remarks>
    /// Выглядит он по-разному. Orleans заворачивает в
    /// <see cref="AddressInUseException" /> только <c>AddressAlreadyInUse</c> —
    /// так занятый порт выглядит на Linux. На Windows тот же занятый порт
    /// приходит сырым <see cref="SocketException" /> с <c>AccessDenied</c>:
    /// чужой листенер держит его эксклюзивно, и так же отвечает диапазон,
    /// зарезервированный ОС.
    /// </remarks>
    public static bool Refused(Exception exception) =>
        exception is AddressInUseException
            or SocketException { SocketErrorCode: SocketError.AddressAlreadyInUse or SocketError.AccessDenied };

    /// <summary>
    /// Строка, которой Orleans сообщает об отказе листенера силоса или шлюза.
    /// Листенеры на этой стадии только биндятся, поэтому для дочернего
    /// процесса, у которого есть только вывод, это и есть признак отказа bind —
    /// одинаковый на всех ОС, в отличие от имени исключения.
    /// </summary>
    public const string ListenerFailure = "ConnectionListener' failed to start";

    /// <summary>Свежая пара портов, ни один из которых этот процесс ещё не выдавал.</summary>
    public static SiloEndpoint Allocate() => new(NextPort(), NextPort());

    private static int NextPort()
    {
        for (var probe = 0; probe < BandEnd - BandStart; probe++)
        {
            var port = BandStart + Interlocked.Increment(ref cursor) % (BandEnd - BandStart);

            if (Bindable(port))
            {
                return port;
            }
        }

        throw new InvalidOperationException($"no bindable port in {BandStart}..{BandEnd - 1}");
    }

    /// <summary>
    /// Порт свободен на петле, где его и слушает силос: <c>NotificationsHost</c>
    /// объявляет адресом loopback.
    /// </summary>
    private static bool Bindable(int port)
    {
        try
        {
            using var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            return true;
        }
        catch (SocketException)
        {
            // Занят чужим процессом или попал в диапазон, зарезервированный ОС
            // (на Windows это делает Hyper-V): следующий номер.
            return false;
        }
    }
}
