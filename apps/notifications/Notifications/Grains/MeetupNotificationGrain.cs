using Notifications.Infrastructure;
using Orleans.Runtime;

namespace Notifications.Grains;

/// <inheritdoc cref="IMeetupNotificationGrain" />
public sealed class MeetupNotificationGrain(
    GrainActivationStore store,
    ILocalSiloDetails silo,
    ILogger<MeetupNotificationGrain> logger) : Grain, IMeetupNotificationGrain
{
    private ActivationRecord? record;

    public override async Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var key = this.GetPrimaryKeyString();

        // Запись идёт при активации, а не по запросу: доказывать нужно именно
        // подъём грина, и он должен оставить след независимо от того, вызовет
        // ли кто-нибудь метод.
        record = await store.Record(key, silo.SiloAddress.ToString(), cancellationToken);

        // Имена плейсхолдеров и есть имена полей структурной записи, поэтому они
        // в snake_case: standards/observability/logging.md требует его, и так же
        // именует свои поля граница Meetups.
        logger.LogInformation(
            "Grain activated {grain_key} {silo} {activations}",
            record.GrainKey,
            record.Silo,
            record.Activations);

        await base.OnActivateAsync(cancellationToken);
    }

    public Task<ActivationRecord> Describe() =>
        Task.FromResult(record ?? throw new InvalidOperationException("grain is not activated"));
}
