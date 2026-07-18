namespace AuctionService.Infrastructure.Persistence;

using Microsoft.EntityFrameworkCore;

public class AuctionDbContext(DbContextOptions<AuctionDbContext> options) : DbContext(options)
{
    public DbSet<LotEntity> Lots { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<LotEntity>(entity =>
        {
            entity.ToTable("lots");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).ValueGeneratedOnAdd();
            entity.HasIndex(e => e.AuctionId);
            entity.Property(e => e.AuctionId).IsRequired().HasMaxLength(26);
            entity.Property(e => e.Title).IsRequired().HasMaxLength(500);
            entity.Property(e => e.Description).HasMaxLength(5000);
            entity.Property(e => e.StartingPrice).IsRequired();
            entity.Property(e => e.MinBidStep).IsRequired();
            entity.Property(e => e.ImageUrl).HasMaxLength(1000);
            entity.Property(e => e.DisplayOrder).IsRequired();
            entity.HasIndex(e => new { e.AuctionId, e.DisplayOrder });
            entity.Property(e => e.CreatedAt).IsRequired().HasDefaultValueSql("NOW()");
        });
    }
}

