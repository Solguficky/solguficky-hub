using System.Runtime.CompilerServices;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Локальный граф <c>hub</c> не меняется от того, что к нему добавляют
/// публикацию. Снимок записан на коде до ветки публикации, и любое изменение
/// запуска — лишний узел, потерянная переменная, другое ожидание — роняет тест
/// строкой диффа. Сознательное изменение графа обновляет снимок тем же
/// изменением, и тогда оно видно на ревью, а не только в живом прогоне.
/// </summary>
public class LocalGraphSnapshotTests
{
    [Fact]
    public async Task Hub_RunModel_MatchesSnapshot()
    {
        var actual = await GraphSnapshot.RenderAsync(["--profile", "hub"], TestContext.Current.CancellationToken);

        var expectedPath = SnapshotPath("hub.run.txt");
        var expected = File.Exists(expectedPath) ? await File.ReadAllTextAsync(expectedPath, TestContext.Current.CancellationToken) : string.Empty;

        if (Lines(actual).SequenceEqual(Lines(expected)))
        {
            return;
        }

        var receivedPath = Path.Combine(AppContext.BaseDirectory, "hub.run.received.txt");
        await File.WriteAllTextAsync(receivedPath, actual, TestContext.Current.CancellationToken);
        actual.ShouldBe(
            expected,
            $"Local hub graph changed. If the change is intended, review {receivedPath} and copy it over {expectedPath}.");
    }

    private static IEnumerable<string> Lines(string text) =>
        text.ReplaceLineEndings("\n").TrimEnd('\n').Split('\n');

    private static string SnapshotPath(string name, [CallerFilePath] string source = "") =>
        Path.Combine(Path.GetDirectoryName(source)!, "Snapshots", name);
}
