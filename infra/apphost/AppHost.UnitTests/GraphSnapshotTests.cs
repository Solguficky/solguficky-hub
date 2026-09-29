using System.Runtime.CompilerServices;
using AppHost.UnitTests.TestUtilities;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Снимки модели настоящего AppHost в обоих режимах. Любое изменение того, чем
/// узел становится, — лишний узел, потерянная переменная, другое ожидание —
/// роняет тест строкой диффа. Сознательное изменение графа обновляет снимок тем
/// же изменением, и тогда оно видно на ревью, а не только в живом прогоне или
/// на кластере.
/// </summary>
public class GraphSnapshotTests
{
    /// <summary>
    /// Локальный граф <c>hub</c> не меняется от того, что к нему добавили
    /// публикацию: снимок записан на коде до ветки публикации.
    /// </summary>
    [Fact]
    public Task Hub_RunModel_MatchesSnapshot() =>
        MatchAsync(["--profile", "hub"], "hub.run.txt");

    /// <summary>
    /// Bind молчит, если узла нет: локально это свойство среза, а в чарте —
    /// дефект, который проходит и <c>helm lint</c>, и правила чарта. Строка
    /// подключения, выпавшая из workload'а, видна здесь потерянной переменной.
    /// </summary>
    [Fact]
    public Task Cluster_PublishModel_MatchesSnapshot() =>
        MatchAsync(
            ["--operation", "publish", "--publisher", "default", "--output-path", Path.GetTempPath()],
            "cluster.publish.txt");

    private static async Task MatchAsync(string[] args, string snapshot)
    {
        var actual = await GraphSnapshot.RenderAsync(args, TestContext.Current.CancellationToken);

        var expectedPath = SnapshotPath(snapshot);
        var expected = File.Exists(expectedPath)
            ? await File.ReadAllTextAsync(expectedPath, TestContext.Current.CancellationToken)
            : string.Empty;

        if (Lines(actual).SequenceEqual(Lines(expected)))
        {
            return;
        }

        var receivedPath = Path.Combine(AppContext.BaseDirectory, Path.ChangeExtension(snapshot, ".received.txt"));
        await File.WriteAllTextAsync(receivedPath, actual, TestContext.Current.CancellationToken);
        actual.ShouldBe(
            expected,
            $"Graph model changed. If the change is intended, review {receivedPath} and copy it over {expectedPath}.");
    }

    private static IEnumerable<string> Lines(string text) =>
        text.ReplaceLineEndings("\n").TrimEnd('\n').Split('\n');

    private static string SnapshotPath(string name, [CallerFilePath] string source = "") =>
        Path.Combine(Path.GetDirectoryName(source)!, "TestUtilities", "Snapshots", name);
}
