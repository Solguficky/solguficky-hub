namespace Notifications.Infrastructure;

/// <summary>
/// Доступ к подпискам на сходки. Строка есть — человек следит за сходкой.
/// </summary>
/// <remarks>
/// Подписка не несёт выбора категорий и не выводится из них: это две
/// независимые плоскости, и вторая живёт в <see cref="PreferenceStore" />.
/// Переопределения у сходки переживают отписку, потому что лежат в своей
/// таблице: человек, вернувшийся к сходке, получает прежние настройки.
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

    // Отписка удаляет строку: контракт не различает «не подписывался» и
    // «отписался», поэтому второе состояние заводить не за чем.
    private const string UnsubscribeSql = """
        DELETE FROM meetup_subscription
        WHERE identity_id = @IdentityId AND meetup_id = @MeetupId;
        """;

    private const string IsSubscribedSql = """
        SELECT EXISTS (
            SELECT 1 FROM meetup_subscription
            WHERE identity_id = @IdentityId AND meetup_id = @MeetupId
        );
        """;

    /// <summary>Подписывает на сходку. Повтор ничего не меняет.</summary>
    public Task Subscribe(UnitOfWork work, Guid identityId, Guid meetupId, CancellationToken cancellationToken) =>
        work.Execute(
            SubscribeSql,
            new { IdentityId = identityId, MeetupId = meetupId, SubscribedAt = DateTime.UtcNow },
            cancellationToken);

    /// <summary>Снимает подписку. Повтор ничего не меняет.</summary>
    public Task Unsubscribe(UnitOfWork work, Guid identityId, Guid meetupId, CancellationToken cancellationToken) =>
        work.Execute(
            UnsubscribeSql,
            new { IdentityId = identityId, MeetupId = meetupId },
            cancellationToken);

    /// <summary>Следит ли человек за сходкой сейчас.</summary>
    public Task<bool> IsSubscribed(
        UnitOfWork work,
        Guid identityId,
        Guid meetupId,
        CancellationToken cancellationToken) =>
        work.Scalar(IsSubscribedSql, new { IdentityId = identityId, MeetupId = meetupId }, cancellationToken);
}
