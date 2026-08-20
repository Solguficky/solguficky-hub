namespace AuctionService.Services;

using AuctionService.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

public class LotRepository(AuctionDbContext context, ILogger<LotRepository> logger)
{
    public async Task<LotEntity> CreateLot(LotEntity lot)
    {
        logger.LogInformation("Creating lot: {Title} for auction {AuctionId}", lot.Title, lot.AuctionId);

        if (string.IsNullOrWhiteSpace(lot.Title))
        {
            throw new ArgumentException("Title cannot be empty");
        }

        if (lot.StartingPrice <= 0)
        {
            throw new ArgumentException("Starting price must be greater than 0");
        }

        if (lot.MinBidStep <= 0)
        {
            throw new ArgumentException("Min bid step must be greater than 0");
        }

        lot.CreatedAt = DateTime.UtcNow;
        context.Lots.Add(lot);
        await context.SaveChangesAsync();

        logger.LogInformation("Lot created with ID: {LotId}", lot.Id);
        return lot;
    }

    public async Task<LotEntity?> GetLot(int lotId)
    {
        return await context.Lots.FindAsync(lotId);
    }

    public async Task<List<LotEntity>> GetLotsByAuctionId(string auctionId)
    {
        logger.LogInformation("Fetching lots for auction {AuctionId}", auctionId);
        return await context.Lots
            .Where(l => l.AuctionId == auctionId)
            .OrderBy(l => l.Id)
            .ToListAsync();
    }

    public async Task<LotEntity> UpdateLot(int lotId, LotEntity updatedLot)
    {
        logger.LogInformation("Updating lot {LotId}", lotId);

        var existing = await context.Lots.FindAsync(lotId);
        if (existing == null)
        {
            throw new InvalidOperationException($"Lot {lotId} not found");
        }

        existing.Title = updatedLot.Title;
        existing.Description = updatedLot.Description;
        existing.StartingPrice = updatedLot.StartingPrice;
        existing.MinBidStep = updatedLot.MinBidStep;
        existing.ImageUrl = updatedLot.ImageUrl;
        existing.UpdatedAt = DateTime.UtcNow;

        await context.SaveChangesAsync();
        logger.LogInformation("Lot {LotId} updated", lotId);

        return existing;
    }

    public async Task DeleteLot(int lotId)
    {
        logger.LogInformation("Deleting lot {LotId}", lotId);

        var lot = await context.Lots.FindAsync(lotId);
        if (lot == null)
        {
            throw new InvalidOperationException($"Lot {lotId} not found");
        }

        context.Lots.Remove(lot);
        await context.SaveChangesAsync();

        logger.LogInformation("Lot {LotId} deleted", lotId);
    }
}

