using System.Runtime.CompilerServices;
using AppHost.Configuration;
using AppHost.UnitTests.TestUtilities;
using Aspire.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
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
    /// публикацию: снимок записан на коде до ветки публикации. Фаза снимка —
    /// после Build, до BeforeStartEvent: installer всегда node без install args.
    /// Команда npm install появляется только при подготовке настоящего запуска.
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
            PublishArgs(),
            "cluster.publish.txt");

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Snapshot_Rendering_DoesNotStartLifecycle(bool publish)
    {
        var beforeStartCalls = 0;
        var guard = new StartGuard();
        var args = SnapshotArgs(publish);

        await GraphSnapshot.RenderAsync(args, TestContext.Current.CancellationToken, builder =>
        {
            builder.OnBeforeStart((_, _) =>
            {
                Interlocked.Increment(ref beforeStartCalls);
                throw new InvalidOperationException("Snapshot must not execute BeforeStartEvent.");
            });
            builder.Services.AddSingleton<IHostedService>(guard);
        });

        // RenderAsync уже освободил приложение: disposal тоже не должен запускать его.
        beforeStartCalls.ShouldBe(0);
        guard.StartCalls.ShouldBe(0);
    }

    /// <summary>
    /// Проверяет только то, что разрешает сам builder и чтение конфигурации.
    /// Имя приложения, content root и окружение RenderAsync выставляет руками до
    /// configure, поэтому их проверка здесь не упала бы ни на какой поломке.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Snapshot_Bootstrap_UsesAppHostConfiguration(bool publish)
    {
        await GraphSnapshot.RenderAsync(SnapshotArgs(publish), TestContext.Current.CancellationToken, builder =>
        {
            builder.AppHostAssembly.ShouldBe(typeof(AppHostTopology).Assembly);
            File.Exists(Path.Combine(builder.AppHostDirectory, "AppHost.csproj")).ShouldBeTrue();
            builder.ExecutionContext.IsPublishMode.ShouldBe(publish);
            builder.Configuration["Topology:PublishProfile"].ShouldBe("cluster");
        });
    }

    private static string[] PublishArgs() =>
        ["--operation", "publish", "--publisher", "default", "--output-path", Path.GetTempPath()];

    private static string[] SnapshotArgs(bool publish) => publish ? PublishArgs() : ["--profile", "hub"];

    [Fact]
    public async Task Hub_Rendering_IsStableAcrossOtherModels()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var first = await GraphSnapshot.RenderAsync(["--profile", "hub"], cancellationToken);

        await GraphSnapshot.RenderAsync(
            PublishArgs(),
            cancellationToken);
        await GraphSnapshot.RenderAsync(["--profile", "identity"], cancellationToken);

        var last = await GraphSnapshot.RenderAsync(["--profile", "hub"], cancellationToken);
        Lines(last).ShouldBe(Lines(first));
    }

    private sealed class StartGuard : IHostedService
    {
        public int StartCalls { get; private set; }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            StartCalls++;
            throw new InvalidOperationException("Snapshot must not start hosted services.");
        }

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

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
