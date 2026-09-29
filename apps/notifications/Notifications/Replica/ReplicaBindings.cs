namespace Notifications.Replica;

/// <summary>
/// Привязан ли каждый потребитель реплики к своему durable и что мешает тем,
/// кто ещё нет.
/// </summary>
/// <remarks>
/// Без признака живой хост с непривязанным потребителем неотличим от хоста,
/// которому просто нечего разбирать: сообщений нет в обоих случаях. Хост
/// стартует раньше привязки — <c>BackgroundService</c> отпускает старт на
/// первом ожидании, — поэтому успешный старт о привязке ничего не говорит.
///
/// Готовность gRPC признак намеренно не читает: гейтить под на шине —
/// решение про поведение развёртывания, оно за PER-375.
/// </remarks>
public sealed class ReplicaBindings
{
    private readonly Dictionary<string, Binding> feeds;

    /// <remarks>
    /// Конструктор один и регистрируется готовым экземпляром: контейнер,
    /// сам подбирая аргумент, подставил бы пустой список, и признак
    /// «все привязаны» был бы истинным до старта первого потребителя.
    /// </remarks>
    public ReplicaBindings(IEnumerable<ReplicaFeed> feeds)
    {
        this.feeds = feeds.ToDictionary(feed => feed.Source, _ => new Binding());
        WhenAllBound = AllBoundOrFirstFailure([.. this.feeds.Values.Select(binding => binding.Outcome.Task)]);
        // Отказ читают не всегда: хост на нём останавливается сам.
        WhenAllBound.ContinueWith(task => _ = task.Exception, TaskContinuationOptions.OnlyOnFaulted);
    }

    /// <summary>
    /// Завершается, когда привязаны все потребители; падает с исключением
    /// первого, чей отказ оказался окончательным, не дожидаясь остальных.
    /// </summary>
    public Task WhenAllBound { get; }

    /// <summary>Сколько попыток привязки этого потребителя отказали транзиентно.</summary>
    public int FailedAttempts(ReplicaFeed feed) => Volatile.Read(ref feeds[feed.Source].FailedAttempts);

    /// <summary>
    /// Причина, по которой привязки нет: окончательный отказ, если он был у
    /// какого-нибудь потребителя, иначе последний транзиентный отказ первого
    /// ещё не привязанного. <c>null</c> — таких отказов нет.
    /// </summary>
    /// <remarks>
    /// Отказ потребителя, который потом привязался, причиной не считается:
    /// иначе он объяснял бы, почему не привязан соседний.
    /// </remarks>
    public Exception? LastFailure() =>
        feeds.Values.Select(binding => binding.Outcome.Task.Exception?.InnerException).FirstOrDefault(failure => failure is not null)
        ?? feeds.Values
            .Where(binding => !binding.Outcome.Task.IsCompleted)
            .Select(binding => binding.LastFailure)
            .FirstOrDefault(failure => failure is not null);

    public void Retrying(ReplicaFeed feed, Exception failure)
    {
        var binding = feeds[feed.Source];
        binding.LastFailure = failure;
        Interlocked.Increment(ref binding.FailedAttempts);
    }

    public void Bound(ReplicaFeed feed) => feeds[feed.Source].Outcome.TrySetResult();

    public void Failed(ReplicaFeed feed, Exception failure)
    {
        var outcome = feeds[feed.Source].Outcome;
        outcome.TrySetException(failure);
        // Хост на этом отказе останавливается сам, и читать задачу может быть
        // некому: без отметки исключение ушло бы в UnobservedTaskException.
        _ = outcome.Task.Exception;
    }

    /// <remarks>
    /// Не <see cref="Task.WhenAll(IEnumerable{Task})" />: та ждёт каждого, и
    /// окончательный отказ одного потребителя был бы не виден, пока другой
    /// повторяет привязку.
    /// </remarks>
    private static async Task AllBoundOrFirstFailure(List<Task> pending)
    {
        while (pending.Count > 0)
        {
            var settled = await Task.WhenAny(pending);
            await settled;
            pending.Remove(settled);
        }
    }

    private sealed class Binding
    {
        public readonly TaskCompletionSource Outcome = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int FailedAttempts;
        public volatile Exception? LastFailure;
    }
}
