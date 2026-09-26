using Grpc.Health.V1;
using Grpc.Net.Client;
using Notifications.Preferences;
using Notifications.V1;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>
/// Сервис на изолированной базе и клиент к нему по настоящему каналу.
/// </summary>
/// <remarks>
/// Команды сценариев идут клиентом через Kestrel и h2c, а не вызовом
/// C#-метода: коды отказов контракта — свойство границы, и проверять их в обход
/// транспорта значило бы проверять не то.
/// </remarks>
public sealed class PreferencesUnderTest : IAsyncDisposable
{
    private readonly IsolatedDatabase database;
    private readonly SiloUnderTest silo;
    private readonly GrpcChannel channel;

    private PreferencesUnderTest(IsolatedDatabase database, SiloUnderTest silo, GrpcChannel channel)
    {
        this.database = database;
        this.silo = silo;
        this.channel = channel;
        Client = new NotificationsService.NotificationsServiceClient(channel);
        Health = new Health.HealthClient(channel);
    }

    public NotificationsService.NotificationsServiceClient Client { get; }

    /// <summary>Проба grpc.health.v1 по тому же каналу, что и команды.</summary>
    public Health.HealthClient Health { get; }

    /// <summary>
    /// Операции сервиса напрямую, в обход контракта. Нужны единственному
    /// сценарию — снятию переопределения, у которого пути через gRPC нет.
    /// </summary>
    public PreferenceOperations Operations => silo.Service<PreferenceOperations>();

    public static async Task<PreferencesUnderTest> Start()
    {
        var database = new IsolatedDatabase();
        SiloUnderTest? silo = null;

        // Всё, что может бросить после подъёма хоста, обёрнуто: иначе слушающий
        // силос остался бы жить со своим пулом к базе, которую тут же дропнут
        // WITH (FORCE), и прогон досидел бы до конца с чужим соединением.
        try
        {
            Migrations.Apply(database.ConnectionString);
            silo = await SiloUnderTest.Start(database.ConnectionString);

            // Адрес известен только после старта: порт запрошен нулевым.
            return new PreferencesUnderTest(database, silo, GrpcChannel.ForAddress(silo.Address));
        }
        catch
        {
            if (silo is not null)
            {
                await Safely(silo.DisposeAsync);
            }

            database.Dispose();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        // Каждый шаг уборки отделён от соседа: отказ канала не должен оставить
        // силос поднятым, а отказ силоса — базу неудалённой. Уронить прогон на
        // уборке нельзя, промолчать тоже: осиротевшие ntest_* копятся до упора
        // в лимит соединений.
        await Safely(() =>
        {
            channel.Dispose();
            return ValueTask.CompletedTask;
        });

        await Safely(silo.DisposeAsync);
        await Safely(() =>
        {
            database.Dispose();
            return ValueTask.CompletedTask;
        });
    }

    private static async ValueTask Safely(Func<ValueTask> step)
    {
        try
        {
            await step();
        }
        catch (Exception ex)
        {
            await Console.Error.WriteLineAsync($"cleanup: {ex.Message}");
        }
    }
}
