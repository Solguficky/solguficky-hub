using NotificationsService.Handlers;
using NotificationsService.Services;
using Serilog;
using Serilog.Formatting.Compact;

var builder = WebApplication.CreateBuilder(args);

Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console(new CompactJsonFormatter())
    .CreateLogger();

builder.Host.UseSerilog();

builder.Services.AddSingleton<INatsPublisher, NatsPublisher>();
builder.Services.AddTransient<IEventHandler, BidPlacedHandler>();
builder.Services.AddSingleton<EventDispatcher>();
builder.Services.AddHostedService<NatsEventListener>();

builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/health");
app.MapGet("/", () => "Notifications Service");

try
{
    Log.Information("Starting Notifications Service");
    app.Run();
}
catch (Exception ex)
{
    Log.Fatal(ex, "Application start-up failed");
}
finally
{
    Log.CloseAndFlush();
}
