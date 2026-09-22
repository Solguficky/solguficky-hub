using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Dapper;
using Npgsql;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>
/// Сервис, поднятый настоящим дочерним процессом.
/// </summary>
/// <remarks>
/// Нужен ровно для одного: силос должен уметь умереть неснято. Остановка хоста
/// в процессе теста закрывает запись membership корректно, и отличить её от
/// падения нельзя — <c>SiloRestartTests</c> прямо об этом пишет. Убитый процесс
/// оставляет запись в состоянии Active, и только после этого сценарий «кластер
/// лежал в момент срабатывания» проверяется, а не заявляется.
///
/// Готовность и смерть читаются из таблицы membership, а не из вывода процесса:
/// это то же состояние, по которому Orleans принимает свои решения.
/// </remarks>
public sealed class ServiceProcess : IDisposable
{
    /// <summary>Значения Status в таблице membership Orleans.</summary>
    public const int Active = 3;

    /// <inheritdoc cref="Active" />
    public const int Dead = 6;

    private readonly Process process;
    private readonly StringBuilder output = new();

    private ServiceProcess(Process process, int siloPort, int gatewayPort)
    {
        this.process = process;
        SiloPort = siloPort;
        GatewayPort = gatewayPort;
    }

    /// <summary>Порт силоса этого процесса.</summary>
    /// <remarks>
    /// Нужен наружу, потому что восстановление после падения обязано занять тот
    /// же адрес: Orleans пропускает при проверке связности только записи того же
    /// логического силоса, а логический силос — это адрес. Рестарт на новом
    /// порту в кластер не войдёт и будет пять минут ждать ответа от покойника.
    /// В развёртывании это выполняется само собой — порты штатные и постоянные.
    /// </remarks>
    public int SiloPort { get; }

    /// <inheritdoc cref="SiloPort" />
    public int GatewayPort { get; }

    public static ServiceProcess Start(string connectionString)
    {
        var executable = Executable();
        var siloPort = FreePort();
        var gatewayPort = FreePort();

        var start = new ProcessStartInfo(executable)
        {
            WorkingDirectory = Path.GetDirectoryName(executable)!,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        // Порты свободные по той же причине, что и у внутрипроцессного силоса:
        // параллельные классы тестов и соседнее рабочее дерево.
        start.ArgumentList.Add("--urls=http://127.0.0.1:0");
        start.ArgumentList.Add($"--{NotificationsHost.SiloPortKey}={siloPort}");
        start.ArgumentList.Add($"--{NotificationsHost.GatewayPortKey}={gatewayPort}");

        start.Environment[Migrations.DatabaseUrlVariable] = connectionString;

        var process = Process.Start(start)
            ?? throw new InvalidOperationException($"cannot start {executable}");

        var service = new ServiceProcess(process, siloPort, gatewayPort);

        // Вывод читается всегда: без этого полный буфер канала подвешивает
        // дочерний процесс, а при отказе теста читать было бы нечего.
        process.OutputDataReceived += service.Capture;
        process.ErrorDataReceived += service.Capture;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return service;
    }

    public string Output
    {
        get
        {
            lock (output)
            {
                return output.ToString();
            }
        }
    }

    /// <summary>Ждёт, пока силос объявит себя Active в таблице membership.</summary>
    public async Task<string> WaitUntilActive(string connectionString)
    {
        var deadline = DateTime.UtcNow.AddSeconds(90);

        while (true)
        {
            if (process.HasExited)
            {
                throw new InvalidOperationException(
                    $"service exited with {process.ExitCode} before becoming active:{Environment.NewLine}{Output}");
            }

            var address = Silos(connectionString, Active).SingleOrDefault();

            if (address is not null)
            {
                return address;
            }

            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException($"service did not become active:{Environment.NewLine}{Output}");
            }

            await Task.Delay(200);
        }
    }

    /// <summary>Адреса силосов в заданном состоянии membership.</summary>
    public static IReadOnlyList<string> Silos(string connectionString, int status)
    {
        using var connection = new NpgsqlConnection(connectionString);

        return connection.Query<string>(
            """
            SELECT address || ':' || port AS silo
            FROM orleansmembershiptable
            WHERE status = @status;
            """,
            new { status }).ToList();
    }

    /// <summary>Убивает процесс деревом, не давая ему закрыть запись membership.</summary>
    public void Kill()
    {
        if (!process.HasExited)
        {
            process.Kill(entireProcessTree: true);
        }

        process.WaitForExit();
    }

    public void Dispose()
    {
        try
        {
            Kill();
        }
        catch (Exception ex)
        {
            // Осиротевший процесс дороже шумного Dispose: он держит порты и
            // соединения до конца прогона.
            Console.Error.WriteLine($"cleanup kill: {ex.Message}");
        }

        process.Dispose();
    }

    private void Capture(object sender, DataReceivedEventArgs line)
    {
        if (line.Data is null)
        {
            return;
        }

        lock (output)
        {
            output.AppendLine(line.Data);
        }
    }

    /// <summary>
    /// Собранный исполняемый файл сервиса рядом с тестовым.
    /// </summary>
    /// <remarks>
    /// Конфигурация и TFM берутся из пути самого теста, а не зашиты: иначе
    /// Release-прогон молча запускал бы Debug-сборку.
    ///
    /// Каталог сервиса ищется подъёмом по дереву до папки, в которой лежит его
    /// проект, а не отсчётом фиксированного числа уровней вверх: счёт уровней
    /// молча ломается от любой правки раскладки решения, и ломается он
    /// <c>NullReferenceException</c>, по которому причину не видно.
    /// </remarks>
    private static string Executable()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        var tfm = directory.Name;
        var configuration = directory.Parent?.Name
            ?? throw new InvalidOperationException($"cannot read configuration from {AppContext.BaseDirectory}");

        var name = OperatingSystem.IsWindows() ? "Notifications.exe" : "Notifications";

        for (var candidate = directory; candidate is not null; candidate = candidate.Parent)
        {
            var project = Path.Combine(candidate.FullName, "Notifications", "Notifications.csproj");

            if (!File.Exists(project))
            {
                continue;
            }

            var executable = Path.Combine(candidate.FullName, "Notifications", "bin", configuration, tfm, name);

            return File.Exists(executable)
                ? executable
                : throw new FileNotFoundException(
                    $"service executable not found at {executable}; build the solution first", executable);
        }

        throw new InvalidOperationException(
            $"cannot find the Notifications project above {AppContext.BaseDirectory}");
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
