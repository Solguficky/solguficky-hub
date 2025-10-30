using NATS.Client;
using Serilog;
using Serilog.Formatting.Compact;
using WebSocketGateway.Hubs;
using WebSocketGateway.Services;

var builder = WebApplication.CreateBuilder(args);

Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console(new CompactJsonFormatter())
    .CreateLogger();

builder.Host.UseSerilog();

builder.Services.AddSignalR(options =>
{
    options.EnableDetailedErrors = builder.Environment.IsDevelopment();

    var keepAlive = builder.Configuration.GetValue<int?>("SignalR:KeepAliveIntervalSeconds");
    if (keepAlive.HasValue)
    {
        options.KeepAliveInterval = TimeSpan.FromSeconds(keepAlive.Value);
    }

    var timeout = builder.Configuration.GetValue<int?>("SignalR:ClientTimeoutIntervalSeconds");
    if (timeout.HasValue)
    {
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(timeout.Value);
    }
});

builder.Services.AddSingleton<IConnection>(sp =>
{
    var natsUrl = builder.Configuration["Nats:Url"]
        ?? throw new InvalidOperationException("Nats:Url configuration is missing");

    var factory = new ConnectionFactory();
    var connection = factory.CreateConnection(natsUrl);

    Log.Information("Connected to NATS at {NatsUrl}", natsUrl);

    return connection;
});

builder.Services.AddSingleton<EventMapper>();
builder.Services.AddHostedService<NatsEventListener>();

builder.Services.AddHealthChecks()
    .AddCheck("nats", () =>
    {
        var connection = builder.Services.BuildServiceProvider().GetRequiredService<IConnection>();
        return connection.State == ConnState.CONNECTED
            ? Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult.Healthy("NATS connected")
            : Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult.Unhealthy("NATS disconnected");
    });

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins("http://localhost:3000", "http://localhost:5173")
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});

var app = builder.Build();

app.UseCors();

app.MapHealthChecks("/health");
app.MapGet("/", () => "WebSocket Gateway");

app.MapHub<AuctionHub>("/auctionHub");

try
{
    Log.Information("Starting WebSocket Gateway");
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
