using AppHost.Configuration;

var builder = DistributedApplication.CreateBuilder(args);
AppHostTopology.Configure(builder);
builder.Build().Run();
