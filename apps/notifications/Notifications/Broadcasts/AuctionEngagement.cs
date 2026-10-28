using Auction.V1;
using Grpc.Core;
using Grpc.Net.Client;

namespace Notifications.Broadcasts;

/// <summary>
/// Кто из аукциона в розыгрыше и с прогнозом в открытом раунде — по слову
/// Auction в момент команды (PER-778). Сервис ответ не хранит.
/// </summary>
public interface IAuctionEngagement
{
    Task<EngagementRead> Read(Guid auctionId, Forwarded forwarded);
}

/// <summary>Один вызов <c>ListAuctionEngagement</c>.</summary>
public delegate Task<ListAuctionEngagementResponse> AskAuction(
    ListAuctionEngagementRequest request,
    Metadata headers,
    DateTime deadline,
    CancellationToken cancellationToken);

/// <summary>
/// Адаптер Auction: запрос <c>ListAuctionEngagement</c> и сведение ответа к
/// <see cref="EngagementRead" />. Форма та же, что у <see cref="OwnerAuthority" />:
/// делегат вместо сгенерированного клиента, чтобы сведение проверялось
/// unit-тестом, и <c>null</c> — адрес не задан, тогда сужение честно отвечает
/// «недоступно», а не рассылает всем.
/// </summary>
/// <param name="serviceToken">Свой токен Notifications (ADR-056), как у вызовов владельцев права.</param>
public sealed class AuctionEngagement(AskAuction? auction, string serviceToken, TimeProvider clock) : IAuctionEngagement
{
    /// <summary>Адрес Auction. Префикс сервиса, как у остальных переменных Notifications.</summary>
    public const string AuctionUrlVariable = "NOTIFICATIONS_AUCTION_GRPC_URL";

    /// <summary>Тот же срок, что у вызовов владельцев права: ответа ждёт человек.</summary>
    public static readonly TimeSpan CallDeadline = OwnerAuthority.CallDeadline;

    public async Task<EngagementRead> Read(Guid auctionId, Forwarded forwarded)
    {
        if (auction is null)
        {
            return new EngagementRead.Unavailable("auction address is not configured");
        }

        var request = new ListAuctionEngagementRequest { AuctionId = auctionId.ToString("D") };

        try
        {
            var response = await auction(
                request,
                OwnerCall.Headers(serviceToken, forwarded),
                OwnerCall.Due(clock, CallDeadline, forwarded),
                forwarded.Cancellation);

            return Map(response);
        }
        catch (RpcException declined)
        {
            return Classify(declined.Status);
        }
    }

    /// <summary>
    /// Сведение ответа. Значение вне словаря и неканонический идентификатор —
    /// дефект одной из сторон, а не повод сузить по догадке.
    /// </summary>
    public static EngagementRead Map(ListAuctionEngagementResponse response)
    {
        bool raffleOpen;
        switch (response.RaffleRegistration)
        {
            case RaffleRegistration.Open:
                raffleOpen = true;
                break;
            case RaffleRegistration.NotOpen or RaffleRegistration.Closed:
                raffleOpen = false;
                break;
            default:
                return new EngagementRead.Failed($"auction: raffle registration {response.RaffleRegistration}");
        }

        if (response.HasOpenPredictionRound
            && response.OpenPredictionRound is not (PredictionRound.Catalog or PredictionRound.Final))
        {
            return new EngagementRead.Failed($"auction: prediction round {response.OpenPredictionRound}");
        }

        if (!TryIds(response.RaffleRegistrants, out var registrants) || !TryIds(response.Forecasters, out var forecasters))
        {
            return new EngagementRead.Failed("auction: identity id is not a uuid");
        }

        return new EngagementRead.Known(raffleOpen, registrants, response.HasOpenPredictionRound, forecasters);
    }

    /// <summary>
    /// Сведение отказа. <c>NOT_FOUND</c> — у аукциона нет журнала. Недоступность,
    /// срок и отмена — «не сузить сейчас», как у владельцев права; остальное,
    /// включая <c>UNAUTHENTICATED</c> (дефект развёртывания, ADR-056), — сбой.
    /// </summary>
    public static EngagementRead Classify(Status status) =>
        status.StatusCode switch
        {
            StatusCode.NotFound => new EngagementRead.AuctionNotFound(),
            StatusCode.Unavailable or StatusCode.DeadlineExceeded or StatusCode.Cancelled =>
                new EngagementRead.Unavailable($"auction {status.StatusCode}"),
            _ => new EngagementRead.Failed($"auction {status.StatusCode}"),
        };

    private static bool TryIds(IEnumerable<string> values, out IReadOnlySet<Guid> ids)
    {
        var parsed = new HashSet<Guid>();
        foreach (var value in values)
        {
            if (!Guid.TryParseExact(value, "D", out var id))
            {
                ids = parsed;
                return false;
            }

            parsed.Add(id);
        }

        ids = parsed;
        return true;
    }

    /// <inheritdoc cref="OwnerAuthority.ConnectMeetups" />
    public static AskAuction Connect(string url)
    {
        var client = new AuctionService.AuctionServiceClient(GrpcChannel.ForAddress(url));

        return (request, headers, deadline, cancellationToken) =>
            client.ListAuctionEngagementAsync(request, headers, deadline, cancellationToken).ResponseAsync;
    }
}
