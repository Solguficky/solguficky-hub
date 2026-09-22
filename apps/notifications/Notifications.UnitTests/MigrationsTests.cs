using Shouldly;
using Xunit;

namespace Notifications.UnitTests;

/// <summary>
/// Гейт раскладки миграций. Проверяется не документация, а то, что уронит старт:
/// <see cref="Migrations.List" /> отказывается собирать список, если встроенный
/// скрипт назван мимо норматива или номера пошли не по возрастанию.
/// </summary>
public class MigrationsTests
{
    [Fact]
    public void List_EmbeddedScripts_ReturnsStrictlyAscendingVersions()
    {
        var migrations = Migrations.List();

        migrations.ShouldNotBeEmpty();
        migrations.Select(migration => migration.Version)
            .ShouldBe(migrations.Select(migration => migration.Version).Order(), ignoreOrder: false);
        migrations.Select(migration => migration.Version).Distinct().Count()
            .ShouldBe(migrations.Count);
    }

    [Fact]
    public void List_EmbeddedScripts_CarriesOrleansQueryOwnerBeforeItsUsers()
    {
        // Порядок здесь несущий: таблицы Orleans заводит тот же DbUp, и
        // orleans_main обязан идти до каждого скрипта, который пишет в
        // OrleansQuery, — это и clustering, и reminders.
        //
        // Прежнее имя теста обещало «вендорное до своего», и это больше не
        // верно: orleans_reminders приехал вместе с заданием напоминания и
        // получил номер больше, чем у grain_activation и notification_preferences.
        // Номер применённой миграции не переписывают, а зависимости порядок не
        // нарушает — reminders нужен только orleans_main.
        //
        // Список задан дословно намеренно: он ловит и потерянный
        // EmbeddedResource, и чужой скрипт, приехавший в ту же папку. Цена
        // названа и уплачена: слияние с PER-213, добавившим свою миграцию,
        // остановилось ровно на этой строке, а не на молчаливом расхождении
        // схемы.
        var names = Migrations.List().Select(migration => migration.Name).ToList();

        names.ShouldBe([
            "orleans_main",
            "orleans_clustering",
            "grain_activation",
            "notification_preferences",
            "orleans_reminders",
            "reminder_task",
        ]);

        var main = names.IndexOf("orleans_main");
        names.IndexOf("orleans_clustering").ShouldBeGreaterThan(main);
        names.IndexOf("orleans_reminders").ShouldBeGreaterThan(main);
    }

    [Fact]
    public void List_EmbeddedScripts_CarriesNonEmptySql()
    {
        Migrations.List().ShouldAllBe(migration => migration.Sql.Length > 0);
    }

    [Fact]
    public void ConnectionString_KeywordForm_PassesThroughUnchanged()
    {
        const string keywords = "Host=127.0.0.1;Port=5432;Database=notifications;Username=postgres";

        Migrations.ConnectionString(keywords).ShouldBe(keywords);
    }

    [Fact]
    public void ConnectionString_UriForm_TranslatesToNpgsqlKeywords()
    {
        var translated = Migrations.ConnectionString(
            "postgres://user:secret@db.internal:6543/notifications?sslmode=disable");

        translated.ShouldContain("Host=db.internal");
        translated.ShouldContain("Port=6543");
        translated.ShouldContain("Database=notifications");
        translated.ShouldContain("Username=user");
        translated.ShouldContain("Password=secret");
        translated.ShouldContain("SSL Mode=Disable");
    }

    [Theory]
    [InlineData("disable", "Disable")]
    [InlineData("require", "Require")]
    [InlineData("verify-ca", "VerifyCA")]
    [InlineData("verify-full", "VerifyFull")]
    public void ConnectionString_SslModeSpelling_TranslatesToNpgsqlEnum(string libpq, string npgsql)
    {
        // Дефис в libpq-написании — не косметика: именно `verify-ca` и
        // `verify-full` верифицируют сервер, и именно их отвергал бы перевод,
        // отдающий значение как есть. Комментарий в коде обещает защиту ровно
        // от тихой потери этого параметра, поэтому проверка тут обязательна.
        Migrations.ConnectionString($"postgres://u:p@h:5432/db?sslmode={libpq}")
            .ShouldContain($"SSL Mode={npgsql}");
    }

    [Fact]
    public void ConnectionString_UnknownSslMode_Throws()
    {
        Should.Throw<InvalidOperationException>(
            () => Migrations.ConnectionString("postgres://u:p@h:5432/db?sslmode=paranoid"));
    }

    [Fact]
    public void ConnectionString_UnknownUriParameter_Throws()
    {
        // Тихо потерянный параметр опаснее отказа: пропавший sslmode=verify-full
        // понижает TLS до неверифицируемого, и заметить это нечем.
        Should.Throw<InvalidOperationException>(
            () => Migrations.ConnectionString("postgres://user@host:5432/db?unsupported=1"));
    }
}
