using AppHost.Configuration;
using AppHost.Configuration.Models;
using AppHost.Configuration.Services;
using AppHost.Configuration.Topology;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.Configuration;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Meetups спрашивает у Identity роль для CheckMeetupAuthority (ADR-051). Связь
/// без симптома: пропусти её — сборка зелёная, ресурсы здоровы, а метод в
/// <c>hub</c> всегда отвечает UNAVAILABLE. Поэтому она проверяется на настоящем
/// setup Meetups, а Identity заменён дешёвым узлом с тем же endpoint.
/// </summary>
public class MeetupsIdentityWiringTests
{
    private const string Identity = AppHostNames.Resources.Identity;
    private const string Meetups = AppHostNames.Resources.Meetups;

    private static IDistributedApplicationBuilder Builder(string profile, string[] services)
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });

        // Та же очистка, что в ServiceGraphTests: тест видит только свою топологию.
        // Соседний профиль владеет Identity, иначе граф отверг бы зарегистрированный
        // узел без владельца раньше, чем дошёл бы до проверяемой связи.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(
            services
                .Select((service, index) => new KeyValuePair<string, string?>(
                    $"Topology:Profiles:{profile}:Services:{index}", service))
                .Append(new KeyValuePair<string, string?>("Topology:Profiles:identity:Services:0", Identity)));
        return builder;
    }

    private static IResource Materialize(string profile, string[] services)
    {
        var builder = Builder(profile, services);
        var graph = new ServiceGraph(
            builder,
            new ProfileConfig { Name = profile, Services = [.. services], Infrastructure = [] });

        graph.AddService(Identity, [], context => context.Builder
            .AddContainer(Identity, "busybox")
            .WithHttpEndpoint(targetPort: 8080, name: AppHostNames.Endpoints.Grpc));
        graph.AddService(Meetups, [Identity], MeetupsSetup.Configure);
        graph.Build();

        return builder.Resources.Single(resource => resource.Name == Meetups);
    }

    private static IEnumerable<string> AwaitedBy(IResource resource) =>
        resource.Annotations.OfType<WaitAnnotation>().Select(wait => wait.Resource.Name);

    [Fact]
    public void Meetups_WaitsForIdentity_WhenTheProfileOwnsBoth()
    {
        var meetups = Materialize("hub", [Identity, Meetups]);

        AwaitedBy(meetups).ShouldContain(Identity);
    }

    /// <summary>
    /// Профиль без Identity его не подтягивает: Meetups стартует без адреса, и
    /// проверка права отвечает UNAVAILABLE, а не ждёт узла, которого не будет.
    /// </summary>
    [Fact]
    public void Meetups_StartsWithoutIdentity_WhenTheProfileDoesNotOwnIt()
    {
        var meetups = Materialize("meetups", [Meetups]);

        AwaitedBy(meetups).ShouldNotContain(Identity);
    }
}
