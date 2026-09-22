using System.Diagnostics;
using System.Runtime.InteropServices;
using Contour.Environment;

// Процесс-обёртка: поднимает контур, отдаёт адреса наружу и запускает
// переданную команду в окружении с ними, пробрасывая её код возврата.
//
// Так среда живёт ровно столько, сколько потребитель, и её владелец — этот
// процесс, а не набор тестов. PER-271 написан на TypeScript, средой не владеет
// и получает адреса как обычные переменные окружения.
//
//   contour-host -- npm test
//   contour-host --env-file .contour.env -- npm test
//   contour-host --env-file .contour.env          (держит среду до Ctrl+C)

// 130 — конвенция оболочки для «прервано по SIGINT»; отличает Ctrl+C от
// настоящего отказа дочерней команды.
const int Interrupted = 130;

try
{
    var (envFile, command) = ParseArguments(args);

    using var stopping = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        stopping.Cancel();
    };

    await using var contour = await ContourHost.StartAsync(cancellationToken: stopping.Token);

    if (envFile is not null)
    {
        await contour.Endpoints.WriteDotenvAsync(envFile, stopping.Token);
        Console.WriteLine($"contour: endpoints written to {Path.GetFullPath(envFile)}");
    }

    if (command.Count == 0)
    {
        Console.WriteLine("contour: holding the topology, press Ctrl+C to stop");
        await Task.Delay(Timeout.InfiniteTimeSpan, stopping.Token);
        return 0;
    }

    return await RunAsync(command, contour.Endpoints, stopping.Token);
}
catch (OperationCanceledException)
{
    // Ctrl+C на любом шаге — штатный выход, а не стек в консоль.
    Console.WriteLine("contour: interrupted");
    return Interrupted;
}
catch (ContourFailure failure)
{
    // Класс отказа уже назван типом; стек здесь ничего не добавляет.
    Console.Error.WriteLine(failure.Message);
    return 1;
}

static async Task<int> RunAsync(
    IReadOnlyList<string> command,
    ContourEndpoints endpoints,
    CancellationToken cancellationToken)
{
    var info = Launch(command);

    // Наследуется окружение родителя плюс ровно два ключа. OTEL_* сюда не
    // добавляется: потребителю нужна чистая среда, и дешевле не отдавать
    // лишнего, чем вычищать его на той стороне.
    foreach (var (key, value) in endpoints.AsEnvironment())
    {
        info.Environment[key] = value;
    }

    using var process = Process.Start(info)
        ?? throw new InvalidOperationException($"не удалось запустить '{command[0]}'");

    try
    {
        await process.WaitForExitAsync(cancellationToken);
        return process.ExitCode;
    }
    catch (OperationCanceledException)
    {
        // Без снятия дерева дочерняя команда переживает контур: среда уходит
        // из-под неё, а процесс остаётся висеть.
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None)
                    .WaitAsync(TimeSpan.FromSeconds(10), CancellationToken.None);
            }
        }
        catch (Exception)
        {
            // Уже вышел либо не снимается: код возврата от этого не зависит.
        }

        throw;
    }
}

/// <summary>
/// На Windows `CreateProcess` ищет по PATH только точное имя и `.exe`, поэтому
/// `npm`, `pnpm` и `just` — они `.cmd` — не резолвятся. Потребитель этого входа
/// пишет на TypeScript, то есть `npm` для него штатный вызов.
/// </summary>
static ProcessStartInfo Launch(IReadOnlyList<string> command)
{
    var executable = command[0];
    var arguments = command.Skip(1);

    if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && !Path.HasExtension(executable))
    {
        var shell = new ProcessStartInfo("cmd.exe") { UseShellExecute = false };
        shell.ArgumentList.Add("/c");
        shell.ArgumentList.Add(executable);
        foreach (var argument in arguments)
        {
            shell.ArgumentList.Add(argument);
        }

        return shell;
    }

    var info = new ProcessStartInfo(executable) { UseShellExecute = false };
    foreach (var argument in arguments)
    {
        info.ArgumentList.Add(argument);
    }

    return info;
}

static (string? EnvFile, IReadOnlyList<string> Command) ParseArguments(string[] args)
{
    string? envFile = System.Environment.GetEnvironmentVariable("CONTOUR_ENV_FILE");
    var command = new List<string>();

    for (var index = 0; index < args.Length; index++)
    {
        switch (args[index])
        {
            case "--env-file" when index + 1 < args.Length:
                envFile = args[++index];
                break;

            // Отдельной веткой: иначе забытый путь сообщал бы «неизвестный
            // аргумент --env-file», и читатель искал бы опечатку в имени флага.
            case "--env-file":
                throw new ArgumentException("после --env-file требуется путь к файлу");

            case "--":
                command.AddRange(args.Skip(index + 1));
                return (envFile, command);

            default:
                throw new ArgumentException(
                    $"неизвестный аргумент '{args[index]}'. " +
                    "Использование: contour-host [--env-file <path>] [-- <команда>]");
        }
    }

    return (envFile, command);
}
