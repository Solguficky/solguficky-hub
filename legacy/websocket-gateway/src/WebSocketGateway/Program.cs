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

builder.Services.AddSingleton<EventMapper>();
builder.Services.AddHostedService<NatsEventListener>();

builder.Services.AddHealthChecks();

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
