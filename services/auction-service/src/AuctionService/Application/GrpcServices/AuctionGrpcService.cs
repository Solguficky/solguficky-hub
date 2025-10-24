namespace AuctionService.Application.GrpcServices;

using Akka.Actor;
using AuctionService.Domain.Registry;
using AuctionService.Domain.Session;
using AuctionService.Grpc;
using Grpc.Core;
using DomainResponses = AuctionService.Domain.Session;
using GrpcMessages = AuctionService.Grpc;

public class AuctionGrpcService : GrpcMessages.AuctionService.AuctionServiceBase
{
    private readonly IActorRef _registry;
    private readonly ILogger<AuctionGrpcService> _logger;
    private readonly TimeSpan _timeout = TimeSpan.FromSeconds(5);

    public AuctionGrpcService(IActorRef registry, ILogger<AuctionGrpcService> logger)
    {
        _registry = registry;
        _logger = logger;
    }

    public override async Task<GrpcMessages.AuctionStatusResponse> GetAuctionStatus(
        GrpcMessages.GetAuctionStatusRequest request,
        ServerCallContext context)
    {
        _logger.LogInformation("GetAuctionStatus called for event {EventId}", request.EventId);

        try
        {
            var sessionRef = await _registry.Ask<IActorRef?>(
                new GetAuctionSession(request.EventId),
                _timeout
            );

            if (sessionRef == null)
            {
                throw new RpcException(new Status(StatusCode.NotFound, $"Auction for event {request.EventId} not found"));
            }

            var status = await sessionRef.Ask<DomainResponses.AuctionStatusResponse>(
                new GetAuctionStatus(),
                _timeout
            );

            return new GrpcMessages.AuctionStatusResponse
            {
                EventId = status.EventId,
                Phase = status.Phase.ToString(),
                LotIds = { status.LotIds }
            };
        }
        catch (Exception ex) when (ex is not RpcException)
        {
            _logger.LogError(ex, "Error getting auction status for event {EventId}", request.EventId);
            throw new RpcException(new Status(StatusCode.Internal, "Internal server error"));
        }
    }
}

