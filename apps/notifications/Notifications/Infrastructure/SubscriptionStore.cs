namespace Notifications.Infrastructure;

/// <summary>
/// Доступ к подпискам на сходки. Строка в <c>meetup_subscription</c> есть —
/// человек следит за сходкой; строка в <c>meetup_unsubscription</c> есть —
/// человек отписался сам, и вход в состав организаторов его не подписывает
/// заново (PER-909, ADR-076, п. 5, дополнение 2026-11-21).
/// </summary>
/// <remarks>
/// Подписка не несёт выбора категорий и не выводится из них: это две
/// независимые плоскости, и вторая живёт в <see cref="PreferenceStore" />.
/// Переопределения у сходки переживают отписку, потому что лежат в своей
/// таблице: человек, вернувшийся к сходке, получает прежние настройки.
///
/// Память об отписке — отдельная таблица, а не состояние строки подписки:
/// развороты аудитории читают одну <c>meetup_subscription</c>, и развести
/// «не подписывался» и «отписался» можно, не трогая ни одного из них.
///
/// Соединение и транзакцию приносит <see cref="UnitOfWork" /> — по той же
/// причине, что и у соседнего хранилища.
/// </remarks>
public sealed class SubscriptionStore
{
    // Повторная подписка не сдвигает момент: команда идемпотентна, а
    // subscribed_at отвечает на вопрос «с каких пор следит», а не «когда
    // последний раз нажал».
    private const string SubscribeSql = """
        INSERT INTO meetup_subscription (identity_id, meetup_id, subscribed_at)
        VALUES (@IdentityId, @MeetupId, @SubscribedAt)
        ON CONFLICT (identity_id, meetup_id) DO NOTHING;
        """;

    // Отписка удаляет подписку, как и раньше, но оставляет память о себе:
    // контракт по-прежнему не различает два состояния, а сервису они нужны —
    // без памяти вход в состав организаторов вернул бы подписку человеку,
    // который отказался сам. Повтор отписки момент не сдвигает: он отвечает на
    // вопрос «с каких пор отписался», а не «когда последний раз нажал».
    private const string UnsubscribeSql = """
        DELETE FROM meetup_subscription
        WHERE identity_id = @IdentityId AND meetup_id = @MeetupId;
        """;

    private const string RememberUnsubscriptionSql = """
        INSERT INTO meetup_unsubscription (identity_id, meetup_id, unsubscribed_at)
        VALUES (@IdentityId, @MeetupId, @UnsubscribedAt)
        ON CONFLICT (identity_id, meetup_id) DO NOTHING;
        """;

    // Явная подписка стирает память: человек снова попросил присылать.
    private const string ForgetUnsubscriptionSql = """
        DELETE FROM meetup_unsubscription
        WHERE identity_id = @IdentityId AND meetup_id = @MeetupId;
        """;

    // Подписка по входу в состав организаторов — создание сходки автором и
    // назначение (PER-909). Строка появляется только там, где памяти об
    // отписке нет: явная отписка сильнее действия организатора.
    private const string AutoSubscribeSql = """
        INSERT INTO meetup_subscription (identity_id, meetup_id, subscribed_at)
        SELECT @IdentityId, @MeetupId, @SubscribedAt
        WHERE NOT EXISTS (
            SELECT 1 FROM meetup_unsubscription
            WHERE identity_id = @IdentityId AND meetup_id = @MeetupId
        )
        ON CONFLICT (identity_id, meetup_id) DO NOTHING;
        """;

    private const string IsSubscribedSql = """
        SELECT EXISTS (
            SELECT 1 FROM meetup_subscription
            WHERE identity_id = @IdentityId AND meetup_id = @MeetupId
        );
        """;

    // Подписка, отписка и вход в состав трогают одну пару «человек и сходка»,
    // и гонку между ними разводит блокировка пары, а не строки: строки памяти
    // может ещё не быть, а FOR UPDATE по отсутствующей строке ничего не держит.
    // Без блокировки отписка и автоподписка разминутся так: отписка удалит
    // подписку, автоподписка не увидит ещё не закоммиченной памяти и вставит
    // подписку — человек продолжит получать сообщения вопреки своей отписке.
    private const string PairLockSql = """
        SELECT pg_advisory_xact_lock(
            hashtextextended(
                'notifications.meetup_subscription:' || CAST(@IdentityId AS text) || ':' || CAST(@MeetupId AS text),
                0));
        """;

    /// <summary>
    /// Подписывает на сходку по команде человека. Повтор ничего не меняет, а
    /// прежняя отписка забывается: человек снова попросил присылать.
    /// </summary>
    public async Task Subscribe(UnitOfWork work, Guid identityId, Guid meetupId, CancellationToken cancellationToken)
    {
        var parameters = new { IdentityId = identityId, MeetupId = meetupId };

        await work.Execute(PairLockSql, parameters, cancellationToken);
        await work.Execute(ForgetUnsubscriptionSql, parameters, cancellationToken);
        await work.Execute(
            SubscribeSql,
            new { IdentityId = identityId, MeetupId = meetupId, SubscribedAt = DateTime.UtcNow },
            cancellationToken);
    }

    /// <summary>
    /// Снимает подписку и запоминает, что её снял сам человек. Повтор ничего не
    /// меняет.
    /// </summary>
    public async Task Unsubscribe(UnitOfWork work, Guid identityId, Guid meetupId, CancellationToken cancellationToken)
    {
        var parameters = new { IdentityId = identityId, MeetupId = meetupId };

        await work.Execute(PairLockSql, parameters, cancellationToken);
        await work.Execute(UnsubscribeSql, parameters, cancellationToken);
        await work.Execute(
            RememberUnsubscriptionSql,
            new { IdentityId = identityId, MeetupId = meetupId, UnsubscribedAt = DateTime.UtcNow },
            cancellationToken);
    }

    /// <summary>
    /// Подписывает человека на сходку, в состав которой он вошёл. Отписавшегося
    /// не трогает: его выбор сильнее входа в состав. Живую подписку тоже не
    /// трогает — момент подписки остаётся прежним.
    /// </summary>
    public static async Task AutoSubscribe(
        UnitOfWork work,
        Guid identityId,
        Guid meetupId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var parameters = new { IdentityId = identityId, MeetupId = meetupId };

        await work.Execute(PairLockSql, parameters, cancellationToken);
        await work.Execute(
            AutoSubscribeSql,
            new { IdentityId = identityId, MeetupId = meetupId, SubscribedAt = now.UtcDateTime },
            cancellationToken);
    }

    /// <summary>Следит ли человек за сходкой сейчас.</summary>
    public Task<bool> IsSubscribed(
        UnitOfWork work,
        Guid identityId,
        Guid meetupId,
        CancellationToken cancellationToken) =>
        work.Scalar(IsSubscribedSql, new { IdentityId = identityId, MeetupId = meetupId }, cancellationToken);
}
