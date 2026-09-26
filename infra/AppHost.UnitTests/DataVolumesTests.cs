using AppHost.Configuration;
using AppHost.Configuration.Infrastructure;
using AppHost.Configuration.Models;
using AppHost.Configuration.Topology;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Том данных принадлежит рабочему дереву (PER-340). Дерево задаётся каталогом
/// AppHost, поэтому тест подставляет его через <c>ProjectDirectory</c> и
/// читает монтирование настоящего setup, а не формулу имени.
/// </summary>
public class DataVolumesTests
{
    private static readonly string Trees = Path.Combine(Path.GetTempPath(), "solguficky-volume-tests");

    private static IDistributedApplicationBuilder Builder(string tree) =>
        DistributedApplication.CreateBuilder(new DistributedApplicationOptions
        {
            Args = [],
            DisableDashboard = true,
            ProjectDirectory = Path.Combine(Trees, tree, "infra", "apphost"),
        });

    private static ServiceGraphContext Context(string tree) =>
        new(Builder(tree), new ProfileConfig { Name = "hub" });

    private static string Volume<T>(IResourceBuilder<T> resource) where T : IResource =>
        resource.Resource.Annotations.OfType<ContainerMountAnnotation>()
            .Single(mount => mount.Type == ContainerMountType.Volume)
            .Source!;

    private static string PostgresVolume(string tree) => Volume(PostgresSetup.Configure(Context(tree)));

    private static string NatsVolume(string tree) => Volume(NatsSetup.Configure(Context(tree)));

    [Fact]
    public void Name_PostgresInTwoTrees_GetsDifferentVolumes() =>
        PostgresVolume("solguficky-hub").ShouldNotBe(PostgresVolume("per-340-worktree"));

    [Fact]
    public void Name_PostgresRunAgainInSameTree_GetsSameVolume() =>
        PostgresVolume("per-340-worktree").ShouldBe(PostgresVolume("per-340-worktree"));

    [Fact]
    public void Name_NatsInTwoTrees_GetsDifferentVolumes() =>
        NatsVolume("solguficky-hub").ShouldNotBe(NatsVolume("per-340-worktree"));

    [Fact]
    public void Name_NatsRunAgainInSameTree_GetsSameVolume() =>
        NatsVolume("per-340-worktree").ShouldBe(NatsVolume("per-340-worktree"));

    /// <summary>
    /// Одно имя каталога у двух клонов — обычное дело: `solguficky-hub` лежит
    /// и в основном клоне, и в копии на другом диске. Различает их хэш пути.
    /// </summary>
    [Fact]
    public void Name_SameDirectoryNameInDifferentParents_GetDifferentVolumes()
    {
        var first = DataVolumes.Name(Builder(Path.Combine("a", "solguficky-hub")), "postgres-data");
        var second = DataVolumes.Name(Builder(Path.Combine("b", "solguficky-hub")), "postgres-data");

        first.ShouldNotBe(second);
    }

    [Fact]
    public void Name_Tree_IsRecognisableInDockerVolumeList()
    {
        var name = DataVolumes.Name(Builder("per-340-worktree"), "postgres-data");

        name.ShouldStartWith("solguficky-per-340-worktree-");
        name.ShouldEndWith("-postgres-data");
    }

    /// <summary>
    /// Docker отвергает том с символом вне [a-zA-Z0-9_.-] уже на старте
    /// контейнера, а не на сборке графа, — поэтому имя каталога чистится здесь.
    /// </summary>
    [Fact]
    public void Name_TreeWithSpacesAndCyrillic_IsValidDockerVolumeName()
    {
        var name = DataVolumes.Name(Builder("Моё дерево (копия)"), "postgres-data");

        name.ShouldMatch("^[a-zA-Z0-9][a-zA-Z0-9_.-]+$");
    }
}
