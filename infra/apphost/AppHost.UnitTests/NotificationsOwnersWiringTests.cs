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
/// Notifications спрашивает право на ручную рассылку у Meetups и Identity
/// (ADR-028 §7, ADR-051). Связь без симптома: пропусти её — сборка зелёная,
/// ресурсы здоровы, а обе рассылки в <c>hub</c> всегда отвечают UNAVAILABLE.
/// Поэтому она проверяется на настоящем setup Notifications, а владельцы
/// заменены дешёвыми узлами с тем же endpoint.
/// </summary>
public class NotificationsOwnersWiringTests
{
    private const string Identity = AppHostNames.Resources.Identity;
    private const string Meetups = AppHostNames.Resources.Meetups;
    private const string Notifications = AppHostNames.Resources.Notifications;

    private static IResource Materialize(string profile, string[] services)
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });

        // Та же очистка, что в ServiceGraphTests. Соседний профиль владеет
        // обоими владельцами, иначе граф отверг бы зарегистрированный узел без
        // владельца раньше, чем дошёл бы до проверяемой связи.
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(
            services
                .Select((service, index) => new KeyValuePair<string, string?>(
                    $"Topology:Profiles:{profile}:Services:{index}", service))
                .Append(new KeyValuePair<string, string?>("Topology:Profiles:owners:Services:0", Identity))
                .Append(new KeyValuePair<string, string?>("Topology:Profiles:owners:Services:1", Meetups)));

        var graph = new ServiceGraph(
            builder,
            new ProfileConfig { Name = profile, Services = [.. services], Infrastructure = [] });

        graph.AddService(Identity, [], context => Stub(context, Identity));
        graph.AddService(Meetups, [], context => Stub(context, Meetups));
        graph.AddService(Notifications, [Identity, Meetups], NotificationsSetup.Configure);
        graph.Build();

        return builder.Resources.Single(resource => resource.Name == Notifications);
    }

    private static IResourceBuilder<ContainerResource> Stub(ServiceGraphContext context, string name) =>
        context.Builder
            .AddContainer(name, "busybox")
            .WithHttpEndpoint(targetPort: 8080, name: AppHostNames.Endpoints.Grpc);

    private static IEnumerable<string> AwaitedBy(IResource resource) =>
        resource.Annotations.OfType<WaitAnnotation>().Select(wait => wait.Resource.Name);

    [Fact]
    public void Notifications_WaitsForBothOwners_WhenTheProfileOwnsThem()
    {
        var notifications = Materialize("hub", [Identity, Meetups, Notifications]);

        AwaitedBy(notifications).ShouldContain(Identity);
        AwaitedBy(notifications).ShouldContain(Meetups);
    }

    /// <summary>
    /// Профиль без владельцев их не подтягивает: Notifications стартует без
    /// адресов, и рассылки отвечают UNAVAILABLE, а не ждут узлов, которых не будет.
    /// </summary>
    [Fact]
    public void Notifications_StartsWithoutOwners_WhenTheProfileDoesNotOwnThem()
    {
        var notifications = Materialize("notifications", [Notifications]);

        AwaitedBy(notifications).ShouldNotContain(Identity);
        AwaitedBy(notifications).ShouldNotContain(Meetups);
    }
}
