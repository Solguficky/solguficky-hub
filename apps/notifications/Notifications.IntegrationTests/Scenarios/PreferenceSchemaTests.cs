using Dapper;
using Notifications.IntegrationTests.Infrastructure;
using Npgsql;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Инварианты доменной схемы, проверенные мимо сервиса — сырым SQL.
/// </summary>
/// <remarks>
/// Обход сервиса здесь и есть смысл набора. Отказ <c>INVALID_ARGUMENT</c> на
/// границе gRPC держит контракт для того единственного клиента, который ходит
/// через неё сегодня; эти утверждения держат тот же инвариант против всех
/// остальных писателей в таблицу — обработчиков реплики (PER-215), заданий
/// напоминания (PER-222) и ручного SQL. RFC-005 §2 просит именно ограничения
/// схемы, а не проверки в коде.
///
/// Каждый тест строится от одного валидного образца и переопределяет то поле,
/// которым отличается: отличие от нормы и есть суть теста.
/// </remarks>
public class PreferenceSchemaTests
{
    private const string CheckViolation = "23514";
    private const string UniqueViolation = "23505";

    private const string InsertPreferenceSql = """
        INSERT INTO notification_preference (identity_id, meetup_id, category, enabled, updated_at)
        VALUES (@IdentityId, @MeetupId, @Category, @Enabled, now());
        """;

    private const string InsertSubscriptionSql = """
        INSERT INTO meetup_subscription (identity_id, meetup_id, subscribed_at)
        VALUES (@IdentityId, @MeetupId, now());
        """;

    /// <summary>Законная глобальная настройка: от неё отличаются все случаи ниже.</summary>
    private static PreferenceRow Valid => new(Guid.CreateVersion7(), null, "meetup_changed", true);

    [Fact]
    public void Insert_GlobalOnlyCategoryScopedToMeetup_ViolatesCheckConstraint()
    {
        using var db = Applied();
        using var connection = new NpgsqlConnection(db.ConnectionString);

        // «Новая опубликованная сходка» и «объявление сообществу» существуют
        // только глобально: подписки, к которой их привязать, не существует.
        foreach (var category in new[] { "meetup_published", "community_announcement" })
        {
            var scopedToMeetup = Valid with { MeetupId = Guid.CreateVersion7(), Category = category };

            var rejected = Should.Throw<PostgresException>(
                () => connection.Execute(InsertPreferenceSql, scopedToMeetup));

            rejected.SqlState.ShouldBe(CheckViolation);
        }
    }

    [Fact]
    public void Insert_GlobalOnlyCategoryWithoutMeetup_IsAccepted()
    {
        using var db = Applied();
        using var connection = new NpgsqlConnection(db.ConnectionString);

        // Обратная сторона того же ограничения: глобально эти категории законны
        // и отключаются, как любые другие. Неотключаемых категорий в продукте нет.
        var globalAnnouncement = Valid with { Category = "community_announcement", Enabled = false };

        Should.NotThrow(() => connection.Execute(InsertPreferenceSql, globalAnnouncement));
    }

    [Fact]
    public void Insert_CategoryOutsideDictionary_ViolatesCheckConstraint()
    {
        using var db = Applied();
        using var connection = new NpgsqlConnection(db.ConnectionString);

        var unknownCategory = Valid with { Category = "meetup_cancelled" };

        var rejected = Should.Throw<PostgresException>(
            () => connection.Execute(InsertPreferenceSql, unknownCategory));

        rejected.SqlState.ShouldBe(CheckViolation);
    }

    [Fact]
    public void Insert_SecondGlobalRowForSameCategory_ViolatesPartialUniqueIndex()
    {
        using var db = Applied();
        using var connection = new NpgsqlConnection(db.ConnectionString);

        var row = Valid;

        connection.Execute(InsertPreferenceSql, row);

        // Обычный UNIQUE по тройке колонок этот случай пропустил бы: NULL не
        // равен NULL, поэтому две глобальные строки для него не конфликтуют.
        // Ловит его только частичный индекс с предикатом meetup_id IS NULL.
        var rejected = Should.Throw<PostgresException>(() => connection.Execute(InsertPreferenceSql, row));

        rejected.SqlState.ShouldBe(UniqueViolation);
    }

    [Fact]
    public void Insert_SecondOverrideForSameMeetupAndCategory_ViolatesPartialUniqueIndex()
    {
        using var db = Applied();
        using var connection = new NpgsqlConnection(db.ConnectionString);

        var row = Valid with { MeetupId = Guid.CreateVersion7(), Category = "meetup_reminder" };

        connection.Execute(InsertPreferenceSql, row);

        var rejected = Should.Throw<PostgresException>(() => connection.Execute(InsertPreferenceSql, row));

        rejected.SqlState.ShouldBe(UniqueViolation);
    }

    [Fact]
    public void Insert_SameCategoryGloballyAndAtMeetup_IsAccepted()
    {
        using var db = Applied();
        using var connection = new NpgsqlConnection(db.ConnectionString);

        var global = Valid;

        connection.Execute(InsertPreferenceSql, global);

        // Ровно та пара строк, ради которой таблица одна: глобальное значение и
        // переопределение у сходки сосуществуют, и второе не затирает первое.
        var atMeetup = global with { MeetupId = Guid.CreateVersion7(), Enabled = false };

        Should.NotThrow(() => connection.Execute(InsertPreferenceSql, atMeetup));
    }

    [Fact]
    public void Insert_SameSubscriptionTwice_ViolatesPrimaryKey()
    {
        using var db = Applied();
        using var connection = new NpgsqlConnection(db.ConnectionString);

        var row = new { IdentityId = Guid.CreateVersion7(), MeetupId = Guid.CreateVersion7() };

        connection.Execute(InsertSubscriptionSql, row);

        var rejected = Should.Throw<PostgresException>(() => connection.Execute(InsertSubscriptionSql, row));

        rejected.SqlState.ShouldBe(UniqueViolation);
    }

    /// <summary>Изолированная база с применённой схемой.</summary>
    private static IsolatedDatabase Applied()
    {
        var db = new IsolatedDatabase();

        // Отказ миграций не должен оставить базу: иначе каждый такой прогон
        // копит осиротевшую ntest_* до упора в лимит соединений.
        try
        {
            Migrations.Apply(db.ConnectionString);
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    /// <summary>Строка настройки. Запись, чтобы отличие задавалось через <c>with</c>.</summary>
    private sealed record PreferenceRow(Guid IdentityId, Guid? MeetupId, string Category, bool Enabled);
}
