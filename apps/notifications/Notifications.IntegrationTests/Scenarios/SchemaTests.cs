using Dapper;
using Notifications.IntegrationTests.Infrastructure;
using Npgsql;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Проверки из <c>docs/standards/data/postgresql.md</c>: схема сервиса живёт в
/// его базе, механизм миграций один, повторный прогон успешен.
/// </summary>
public class SchemaTests
{
    [Fact]
    public void Apply_FreshDatabase_CreatesOrleansAndOwnTables()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        using var connection = new NpgsqlConnection(db.ConnectionString);

        // Имена без кавычек PostgreSQL складывает в нижний регистр, поэтому
        // таблицы Orleans ищутся как orleansquery, а не OrleansQuery.
        var tables = connection.Query<string>(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'").ToHashSet();

        tables.ShouldContain("orleansquery");
        tables.ShouldContain("orleansmembershiptable");
        tables.ShouldContain("orleansmembershipversiontable");
        tables.ShouldContain("grain_activation");
        tables.ShouldContain("meetup_subscription");
        tables.ShouldContain("notification_preference");
        tables.ShouldContain("notifications_schema_versions");
    }

    [Fact]
    public void Apply_Twice_Succeeds()
    {
        using var db = new IsolatedDatabase();

        Migrations.Apply(db.ConnectionString);
        Should.NotThrow(() => Migrations.Apply(db.ConnectionString));
    }

    [Fact]
    public void Apply_JournalDropped_Succeeds()
    {
        // Норматив требует идемпотентности самих скриптов: «журнал DbUp сам по
        // себе этим не считается». Скрипты Orleans идемпотентными не приходят —
        // в них нет ни одного IF NOT EXISTS, и они адаптированы при вендоринге.
        // Этот тест и проверяет ту адаптацию: без журнала DbUp прогонит всё
        // заново, на уже существующей схеме.
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        using (var connection = new NpgsqlConnection(db.ConnectionString))
        {
            connection.Execute("DROP TABLE notifications_schema_versions");
        }

        Should.NotThrow(() => Migrations.Apply(db.ConnectionString));
    }
}
