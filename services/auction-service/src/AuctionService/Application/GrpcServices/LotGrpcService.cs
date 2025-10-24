namespace AuctionService.Application.GrpcServices;

using Akka.Actor;
using AuctionService.Application.Services;
using AuctionService.Domain.Lot;
using AuctionService.Domain.Registry;
using AuctionService.Infrastructure.Persistence;
using Grpc.Core;
using GrpcMessages = AuctionService.Grpc;

public class LotGrpcService : GrpcMessages.AuctionService.AuctionServiceBase
{
    private readonly IActorRef _registry;
    private readonly LotCrudService _lotCrudService;
    private readonly ILogger<LotGrpcService> _logger;
    private readonly TimeSpan _timeout = TimeSpan.FromSeconds(5);

    public LotGrpcService(
        IActorRef registry,
        LotCrudService lotCrudService,
        ILogger<LotGrpcService> logger)
    {
        _registry = registry;
        _lotCrudService = lotCrudService;
        _logger = logger;
    }

    public override async Task<GrpcMessages.LotStatusResponse> GetLotStatus(
        GrpcMessages.GetLotStatusRequest request,
        ServerCallContext context)
    {
        _logger.LogInformation("GetLotStatus called for lot {LotId} in event {EventId}",
            request.LotId, request.EventId);

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

            var routeCmd = new RouteLotCommand(request.EventId, request.LotId, new GetStatus());
            var status = await _registry.Ask<StatusResponse>(routeCmd, _timeout);

            var response = new GrpcMessages.LotStatusResponse
            {
                LotId = request.LotId,
                CurrentPrice = status.CurrentPrice
            };

            if (status.LeaderId.HasValue)
            {
                response.LeaderId = status.LeaderId.Value;
            }

            if (status.EndTime.HasValue)
            {
                response.EndTime = status.EndTime.Value.ToUnixTimeSeconds();
            }

            return response;
        }
        catch (Exception ex) when (ex is not RpcException)
        {
            _logger.LogError(ex, "Error getting lot status for lot {LotId}", request.LotId);
            throw new RpcException(new Status(StatusCode.Internal, "Internal server error"));
        }
    }

    public override async Task<GrpcMessages.LotResponse> CreateLot(GrpcMessages.CreateLotRequest request, ServerCallContext context)
    {
        _logger.LogInformation("CreateLot called for event {EventId}", request.EventId);

        try
        {
            var lot = new LotEntity
            {
                EventId = request.EventId,
                Title = request.Title,
                Description = request.Description,
                StartingPrice = request.StartingPrice,
                MinBidStep = request.MinBidStep,
                ImageUrl = request.ImageUrl
            };

            var created = await _lotCrudService.CreateLot(lot);

            return new GrpcMessages.LotResponse
            {
                Id = created.Id,
                EventId = created.EventId,
                Title = created.Title,
                Description = created.Description,
                StartingPrice = created.StartingPrice,
                MinBidStep = created.MinBidStep,
                ImageUrl = created.ImageUrl,
                CreatedAt = created.CreatedAt.ToString("O")
            };
        }
        catch (ArgumentException ex)
        {
            _logger.LogWarning(ex, "Invalid lot data");
            throw new RpcException(new Status(StatusCode.InvalidArgument, ex.Message));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating lot");
            throw new RpcException(new Status(StatusCode.Internal, "Internal server error"));
        }
    }

    public override async Task<GrpcMessages.LotResponse> UpdateLot(GrpcMessages.UpdateLotRequest request, ServerCallContext context)
    {
        _logger.LogInformation("UpdateLot called for lot {LotId}", request.LotId);

        try
        {
            var lot = new LotEntity
            {
                Title = request.Title,
                Description = request.Description,
                StartingPrice = request.StartingPrice,
                MinBidStep = request.MinBidStep,
                ImageUrl = request.ImageUrl
            };

            var updated = await _lotCrudService.UpdateLot(request.LotId, lot);

            return new GrpcMessages.LotResponse
            {
                Id = updated.Id,
                EventId = updated.EventId,
                Title = updated.Title,
                Description = updated.Description,
                StartingPrice = updated.StartingPrice,
                MinBidStep = updated.MinBidStep,
                ImageUrl = updated.ImageUrl,
                CreatedAt = updated.CreatedAt.ToString("O")
            };
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Lot not found");
            throw new RpcException(new Status(StatusCode.NotFound, ex.Message));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating lot");
            throw new RpcException(new Status(StatusCode.Internal, "Internal server error"));
        }
    }

    public override async Task<GrpcMessages.Empty> DeleteLot(GrpcMessages.DeleteLotRequest request, ServerCallContext context)
    {
        _logger.LogInformation("DeleteLot called for lot {LotId}", request.LotId);

        try
        {
            await _lotCrudService.DeleteLot(request.LotId);
            return new GrpcMessages.Empty();
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "Lot not found");
            throw new RpcException(new Status(StatusCode.NotFound, ex.Message));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting lot");
            throw new RpcException(new Status(StatusCode.Internal, "Internal server error"));
        }
    }

    public override async Task<GrpcMessages.GetLotsResponse> GetLots(GrpcMessages.GetLotsRequest request, ServerCallContext context)
    {
        _logger.LogInformation("GetLots called for event {EventId}", request.EventId);

        try
        {
            var lots = await _lotCrudService.GetLotsByEventId(request.EventId);

            var response = new GrpcMessages.GetLotsResponse();
            response.Lots.AddRange(lots.Select(l => new GrpcMessages.LotInfo
            {
                Id = l.Id,
                EventId = l.EventId,
                Title = l.Title,
                Description = l.Description,
                StartingPrice = l.StartingPrice,
                MinBidStep = l.MinBidStep,
                ImageUrl = l.ImageUrl
            }));

            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting lots");
            throw new RpcException(new Status(StatusCode.Internal, "Internal server error"));
        }
    }
}

