namespace AuctionService.Services;

using Akka.Actor;
using Akka.Hosting;
using AuctionService.Actors;
using AuctionService.Actors.Auction;
using Grpc.Core;
using GrpcAuction = Grpc.Auction;
using GrpcStatus = Grpc.Core.Status;

public class AuctionGrpcService(
    IRequiredActor<AuctionRegistry> registryActor,
    LotRepository lotRepository,
    ILogger<AuctionGrpcService> logger) : GrpcAuction.AuctionService.AuctionServiceBase
{
    private readonly IActorRef _registry = registryActor.ActorRef;
    private readonly TimeSpan _timeout = TimeSpan.FromSeconds(5);

    public override async Task<GrpcAuction.GetAllLotsResponse> GetAllLots(
        GrpcAuction.GetAllLotsRequest request,
        ServerCallContext context)
    {
        logger.LogInformation("GetAllLots called for auction {AuctionId}", request.AuctionId);

        try
        {
            var lots = await lotRepository.GetLotsByAuctionId(request.AuctionId);

            var response = new GrpcAuction.GetAllLotsResponse();
            response.Lots.AddRange(lots.Select(l => new GrpcAuction.LotInfo
            {
                Id = (uint)l.Id,
                AuctionId = l.AuctionId,
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
            logger.LogError(ex, "Error getting lots for auction {AuctionId}", request.AuctionId);
            throw new RpcException(new GrpcStatus(StatusCode.Internal, "Internal server error"));
        }
    }

    public override async Task<GrpcAuction.GetLotResponse> GetLot(
        GrpcAuction.GetLotRequest request,
        ServerCallContext context)
    {
        logger.LogInformation("GetLot called for lot {LotId} in auction {AuctionId}",
            request.LotId, request.AuctionId);

        try
        {
            var lot = await lotRepository.GetLot((int)request.LotId);
            if (lot == null)
            {
                throw new RpcException(new GrpcStatus(StatusCode.NotFound, $"Lot {request.LotId} not found"));
            }

            return new GrpcAuction.GetLotResponse
            {
                Lot = new GrpcAuction.LotInfo
                {
                    Id = (uint)lot.Id,
                    AuctionId = lot.AuctionId,
                    Title = lot.Title,
                    Description = lot.Description,
                    StartingPrice = lot.StartingPrice,
                    MinBidStep = lot.MinBidStep,
                    ImageUrl = lot.ImageUrl
                }
            };
        }
        catch (RpcException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error getting lot {LotId}", request.LotId);
            throw new RpcException(new GrpcStatus(StatusCode.Internal, "Internal server error"));
        }
    }

    public override async Task<GrpcAuction.GetAuctionStatusResponse> GetAuctionStatus(
        GrpcAuction.GetAuctionStatusRequest request,
        ServerCallContext context)
    {
        logger.LogInformation("GetAuctionStatus called for auction {AuctionId}", request.AuctionId);

        try
        {
            var status = await _registry.Ask<AuctionStatusResponse>(
                new ForwardToAuction(request.AuctionId, new GetAuctionStatus()),
                _timeout
            );

            return new GrpcAuction.GetAuctionStatusResponse
            {
                AuctionId = status.AuctionId,
                Phase = status.Phase.ToString(),
                LotIds = { status.LotIds.Select(id => (uint)id) }
            };
        }
        catch (AskTimeoutException)
        {
            throw new RpcException(new GrpcStatus(StatusCode.NotFound, $"Auction {request.AuctionId} not found or not responding"));
        }
        catch (RpcException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error getting auction status for auction {AuctionId}", request.AuctionId);
            throw new RpcException(new GrpcStatus(StatusCode.Internal, "Internal server error"));
        }
    }
}

