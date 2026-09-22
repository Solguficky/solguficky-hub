using System.Diagnostics;
using System.Text;

namespace Contour.Environment;

/// <summary>
/// Предусловия проверяются до подъёма и называются словами. Без этого
/// отсутствующий <c>buf</c> выглядит как таймаут готовности Identity через две
/// минуты: узел кодогенерации падает молча, а ждёт вызывающий сервис.
/// </summary>
public static class Preconditions
{
    private static readonly TimeSpan ToolTimeout = TimeSpan.FromSeconds(30);

    private sealed record Tool(string Name, string Executable, string Arguments, string Why);

    private static readonly Tool[] Required =
    [
        new("docker", "docker", "version --format {{.Server.Version}}",
            "поднимает PostgreSQL; на Windows нужен запущенный Docker Desktop"),
        new("go", "go", "version",
            "узел identity-build собирает бинарник Identity"),
        new("buf", "buf", "--version",
            "узел identity-proto генерирует Go-код из contracts/proto"),
    ];

    /// <summary>Версии инструментов для баннера, либо отказ с именем и причиной.</summary>
    public static async Task<IReadOnlyDictionary<string, string>> VerifyAsync(
        CancellationToken cancellationToken)
    {
        var versions = new Dictionary<string, string>(StringComparer.Ordinal);
        var missing = new List<string>();

        foreach (var tool in Required)
        {
            var (ok, output) = await RunAsync(tool.Executable, tool.Arguments, cancellationToken);
            if (ok)
            {
                versions[tool.Name] = output.Trim();
            }
            else
            {
                missing.Add($"  - {tool.Name}: {tool.Why}{System.Environment.NewLine}      {output.Trim()}");
            }
        }

        if (missing.Count > 0)
        {
            var text = new StringBuilder()
                .AppendLine("Сквозной контур не поднять: среда неполна.")
                .AppendLine(string.Join(System.Environment.NewLine, missing))
                .Append("Тулинг компонентов ставит `just tools`; Docker запускается отдельно.");

            throw new ContourEnvironmentUnavailable(text.ToString());
        }

        return versions;
    }

    private static async Task<(bool Ok, string Output)> RunAsync(
        string executable,
        string arguments,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ToolTimeout);

        var info = new ProcessStartInfo(executable, arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        Process? process = null;

        try
        {
            process = Process.Start(info)
                ?? throw new InvalidOperationException($"{executable}: процесс не запустился");

            // Оба потока читаются одновременно. Последовательное чтение вешает
            // дочерний процесс на заполненном буфере stderr: он блокируется на
            // записи, stdout никогда не доходит до EOF, и живой инструмент
            // диагностируется как «не ответил».
            var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);

            await Task.WhenAll(stdout, stderr);
            await process.WaitForExitAsync(timeout.Token);

            return process.ExitCode == 0
                ? (true, await stdout)
                : (false, $"exit {process.ExitCode}: {(((await stderr).Length > 0) ? await stderr : await stdout)}");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Отмена снаружи — не «среда неполна». Без этой ветки Ctrl+C в
            // первые секунды диагностировался бы как отсутствующий инструмент.
            Kill(process);
            throw;
        }
        catch (OperationCanceledException)
        {
            // Свой дедлайн: зависший инструмент снимается, иначе он переживёт
            // прогон и продолжит держать ресурсы.
            Kill(process);
            return (false, $"не ответил за {ToolTimeout.TotalSeconds:0} с");
        }
        catch (Exception exception)
        {
            return (false, exception.Message);
        }
        finally
        {
            process?.Dispose();
        }
    }

    private static void Kill(Process? process)
    {
        try
        {
            if (process is { HasExited: false })
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception)
        {
            // Процесс успел выйти сам либо права не позволяют: диагностику это
            // не меняет, а отказ снятия затёр бы настоящую причину.
        }
    }
}
