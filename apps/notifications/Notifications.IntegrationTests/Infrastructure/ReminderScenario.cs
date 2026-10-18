using Notifications.Grains;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>
/// Сходка на изолированной базе с поднятым силосом: общий Arrange сценариев
/// напоминания.
/// </summary>
/// <remarks>
/// База, миграции, порты силоса и идентификатор сходки к проверяемому свойству
/// отношения не имеют, и в теле теста им делать нечего: норматив требует, чтобы
/// тело читалось бизнес-сценарием, а SQL и ожидание готовности жили в
/// <c>Infrastructure/</c>.
/// </remarks>
public sealed class ReminderScenario : IAsyncDisposable
{
    private readonly IsolatedDatabase database;
    private readonly SiloUnderTest silo;

    private ReminderScenario(IsolatedDatabase database, SiloUnderTest silo)
    {
        this.database = database;
        this.silo = silo;
    }

    /// <summary>Сходка этого сценария. Одна: гранулярность задания — на сходку.</summary>
    public string MeetupId { get; } = Guid.NewGuid().ToString();

    public string ConnectionString => database.ConnectionString;

    /// <summary>Грин сходки — вход в задание напоминания.</summary>
    public IMeetupNotificationGrain Meetup => silo.Grains.GetGrain<IMeetupNotificationGrain>(MeetupId);

    public static async Task<ReminderScenario> Start(params string[] settings)
    {
        var database = new IsolatedDatabase();

        try
        {
            Migrations.Apply(database.ConnectionString);

            var silo = await SiloUnderTest.Start(database.ConnectionString, settings);

            return new ReminderScenario(database, silo);
        }
        catch
        {
            database.Dispose();
            throw;
        }
    }

    public IReadOnlyList<ReminderTaskRow> Tasks() => ReminderProbe.Tasks(ConnectionString, MeetupId);

    public ReminderTaskRow? Live() => ReminderProbe.Live(ConnectionString, MeetupId);

    public int Occasions() => ReminderProbe.Occasions(ConnectionString, MeetupId);

    public async ValueTask DisposeAsync()
    {
        await silo.DisposeAsync();
        database.Dispose();
    }
}
