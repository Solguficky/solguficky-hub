using Notifications.Infrastructure;
using Npgsql;

namespace Notifications.Favorites;

/// <summary>Исход ручной отметки: состояние после команды или лот, которого реплика не знает.</summary>
public abstract record FollowResult
{
    public sealed record Done(bool Following) : FollowResult;
    public sealed record UnknownLot : FollowResult;
}

/// <summary>
/// Избранные лоты по команде из бота аукциона (ADR-063): отметить, снять и
/// прочитать свой список. Транспорт сюда не заходит.
/// </summary>
/// <remarks>
/// Каждая операция — одна транзакция вместе с состоянием, которое она
/// возвращает, как у <see cref="Preferences.PreferenceOperations" />.
/// </remarks>
public sealed class FavoriteOperations(NpgsqlDataSource source, TimeProvider clock)
{
    /// <summary>
    /// Ставит отметку или возвращает снятую. Лот, которого реплика ещё не
    /// знает, отметку не получает: ссылаться ей было бы не на что ни
    /// напоминанию, ни чистке.
    /// </summary>
    public async Task<FollowResult> Follow(Guid identityId, Guid lotId, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        if (!await FavoriteStore.KnownLot(work, lotId, cancellationToken))
        {
            return new FollowResult.UnknownLot();
        }
        await FavoriteStore.Follow(work, identityId, lotId, clock.GetUtcNow(), cancellationToken);
        var following = await FavoriteStore.Following(work, identityId, lotId, cancellationToken);

        await work.Commit(cancellationToken);

        return new FollowResult.Done(following);
    }

    /// <summary>
    /// Снимает отметку. Снятие помнится: следующая ставка человека на этом лоте
    /// отметку не вернёт.
    /// </summary>
    public async Task<bool> Unfollow(Guid identityId, Guid lotId, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        await FavoriteStore.Unfollow(work, identityId, lotId, clock.GetUtcNow(), cancellationToken);
        var following = await FavoriteStore.Following(work, identityId, lotId, cancellationToken);

        await work.Commit(cancellationToken);

        return following;
    }

    public async Task<IReadOnlyList<Guid>> List(Guid identityId, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var lots = await FavoriteStore.List(work, identityId, cancellationToken);

        await work.Commit(cancellationToken);

        return lots;
    }

    /// <summary>
    /// Чистка по сроку: реплики лотов, пришедших в конечное положение раньше
    /// порога, вместе с их отметками.
    /// </summary>
    public async Task<int> Prune(DateTimeOffset threshold, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var removed = await FavoriteStore.Prune(work, threshold, cancellationToken);

        await work.Commit(cancellationToken);

        return removed;
    }
}
