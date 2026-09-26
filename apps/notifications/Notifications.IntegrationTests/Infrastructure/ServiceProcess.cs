using System.Diagnostics;
using System.Text;
using Dapper;
using Notifications.Reminders;
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

    private ServiceProcess(Process process, SiloEndpoint endpoint)
    {
        this.process = process;
        Endpoint = endpoint;
    }

    /// <summary>Порты силоса этого процесса.</summary>
    /// <remarks>
    /// Нужны наружу, потому что восстановление после падения обязано занять тот
    /// же адрес: Orleans пропускает при проверке связности только записи того же
    /// логического силоса, а логический силос — это адрес. Рестарт на новом
    /// порту в кластер не войдёт и будет пять минут ждать ответа от покойника.
    /// В развёртывании это выполняется само собой — порты штатные и постоянные.
    /// Поднимает силос на них <see cref="SiloUnderTest.StartAt" />.
    /// </remarks>
    public SiloEndpoint Endpoint { get; }

    /// <summary>Адрес силоса, под которым он объявил себя Active в membership.</summary>
    public string Address { get; private set; } = "";

    /// <summary>Запускает сервис и ждёт, пока его силос станет Active.</summary>
    /// <param name="natsUrl">
    /// Адрес шины с уже заведёнными durable. Дочерний процесс — настоящий вход
    /// сервиса, а он без шины не стартует.
    /// </param>
    /// <remarks>
    /// Старт повторяется на свежих портах, если процесс умер на bind: это та же
    /// гонка за порт, что и у внутрипроцессного силоса, и повтор безопасен по
    /// той же причине — отказ bind случается раньше записи в membership. Умер
    /// по любой другой причине — это отказ сервиса, и он уходит наружу сразу.
    /// </remarks>
    public static Task<ServiceProcess> Start(string connectionString, string natsUrl) =>
        Start(connectionString, natsUrl, SiloEndpoint.Allocate);

    /// <summary>
    /// То же, но пары портов выдаёт <paramref name="endpoints" />: тест ставит
    /// проигранную гонку за порт заранее.
    /// </summary>
    public static async Task<ServiceProcess> Start(
        string connectionString, string natsUrl, Func<SiloEndpoint> endpoints)
    {
        for (var attempt = 1; ; attempt++)
        {
            var service = Launch(connectionString, natsUrl, endpoints());

            try
            {
                service.Address = await service.WaitUntilActive(connectionString);
                return service;
            }
            catch (InvalidOperationException) when (attempt < SiloEndpoint.LaunchAttempts && service.LostPortRace)
            {
                service.Dispose();
            }
            catch
            {
                service.Dispose();
                throw;
            }
        }
    }

    /// <summary>
    /// Процесс умер, проиграв порт: об отказе листенера Orleans пишет в вывод
    /// строку, одинаковую на всех ОС.
    /// </summary>
    private bool LostPortRace =>
        process.HasExited && Output.Contains(SiloEndpoint.ListenerFailure, StringComparison.Ordinal);

    private static ServiceProcess Launch(string connectionString, string natsUrl, SiloEndpoint endpoint)
    {
        var executable = Executable();

        var start = new ProcessStartInfo(executable)
        {
            WorkingDirectory = Path.GetDirectoryName(executable)!,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        start.ArgumentList.Add("--urls=http://127.0.0.1:0");

        foreach (var argument in endpoint.Arguments)
        {
            start.ArgumentList.Add(argument);
        }

        start.Environment[Migrations.DatabaseUrlVariable] = connectionString;
        start.Environment[NotificationsHost.NatsUrlVariable] = natsUrl;
        start.Environment[CommunityTime.TimeZoneVariable] = SiloUnderTest.CommunityZone;

        var process = Process.Start(start)
            ?? throw new InvalidOperationException($"cannot start {executable}");

        var service = new ServiceProcess(process, endpoint);

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
    private async Task<string> WaitUntilActive(string connectionString)
    {
        var deadline = DateTime.UtcNow.AddSeconds(90);

        while (true)
        {
            if (process.HasExited)
            {
                // Без аргумента WaitForExit дожидается конца асинхронного
                // чтения вывода: иначе последние строки — с причиной смерти —
                // ещё в пути, и ни сообщение, ни LostPortRace их не увидят.
                process.WaitForExit();

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
}
