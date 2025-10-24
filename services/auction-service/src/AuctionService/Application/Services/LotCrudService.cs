namespace AuctionService.Application.Services;

using AuctionService.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

public class LotCrudService
{
    private readonly AuctionDbContext _context;
    private readonly ILogger<LotCrudService> _logger;

    public LotCrudService(AuctionDbContext context, ILogger<LotCrudService> logger)
    {
        _context = context;
        _logger = logger;
    }

    public async Task<LotEntity> CreateLot(LotEntity lot)
    {
        _logger.LogInformation("Creating lot: {Title} for event {EventId}", lot.Title, lot.EventId);

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
        _context.Lots.Add(lot);
        await _context.SaveChangesAsync();

        _logger.LogInformation("Lot created with ID: {LotId}", lot.Id);
        return lot;
    }

    public async Task<LotEntity?> GetLot(int lotId)
    {
        return await _context.Lots.FindAsync(lotId);
    }

    public async Task<List<LotEntity>> GetLotsByEventId(string eventId)
    {
        _logger.LogInformation("Fetching lots for event {EventId}", eventId);
        return await _context.Lots
            .Where(l => l.EventId == eventId)
            .OrderBy(l => l.Id)
            .ToListAsync();
    }

    public async Task<LotEntity> UpdateLot(int lotId, LotEntity updatedLot)
    {
        _logger.LogInformation("Updating lot {LotId}", lotId);

        var existing = await _context.Lots.FindAsync(lotId);
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

        await _context.SaveChangesAsync();
        _logger.LogInformation("Lot {LotId} updated", lotId);

        return existing;
    }

    public async Task DeleteLot(int lotId)
    {
        _logger.LogInformation("Deleting lot {LotId}", lotId);

        var lot = await _context.Lots.FindAsync(lotId);
        if (lot == null)
        {
            throw new InvalidOperationException($"Lot {lotId} not found");
        }

        _context.Lots.Remove(lot);
        await _context.SaveChangesAsync();

        _logger.LogInformation("Lot {LotId} deleted", lotId);
    }
}

