using AppHost.Configuration.Models;
using AppHost.Configuration.Services;
using AppHost.Configuration.Topology;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Structured logs dashboard читает только OTLP. Проект .NET получает
/// OTLP-переменные сам, исполняемый файл и JavaScript-приложение — только через
/// аннотацию; без неё сервис выпадает из фильтра по <c>request_id</c> молча,
/// при зелёной сборке и здоровом ресурсе.
/// </summary>
public class OtlpExportTests
{
    private static ServiceGraphContext Context(string service)
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });
        var profile = new ProfileConfig { Name = "hub", Services = [service], Infrastructure = [] };
        return new ServiceGraphContext(builder, profile);
    }

    [Fact]
    public void Identity_ExportsTelemetryOverOtlp()
    {
        var identity = IdentitySetup.Configure(Context("identity"));

        identity.Resource.Annotations.OfType<OtlpExporterAnnotation>().ShouldNotBeEmpty();
    }

    [Fact]
    public void TelegramBot_ExportsTelemetryOverOtlp()
    {
        var bot = TelegramBotSetup.Configure(Context("telegram-bot"));

        bot.Resource.Annotations.OfType<OtlpExporterAnnotation>().ShouldNotBeEmpty();
    }
}
