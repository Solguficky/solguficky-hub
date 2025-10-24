namespace AuctionService.Infrastructure.Persistence;

using Microsoft.EntityFrameworkCore;

public class AuctionDbContext : DbContext
{
    public AuctionDbContext(DbContextOptions<AuctionDbContext> options) : base(options)
    {
    }

    public DbSet<LotEntity> Lots { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<LotEntity>(entity =>
        {
            entity.ToTable("lots");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).ValueGeneratedOnAdd();
            entity.HasIndex(e => e.EventId);
            entity.Property(e => e.EventId).IsRequired();
            entity.Property(e => e.Title).IsRequired().HasMaxLength(500);
            entity.Property(e => e.Description).HasMaxLength(5000);
            entity.Property(e => e.StartingPrice).IsRequired();
            entity.Property(e => e.MinBidStep).IsRequired();
            entity.Property(e => e.ImageUrl).HasMaxLength(1000);
            entity.Property(e => e.CreatedAt).IsRequired().HasDefaultValueSql("NOW()");
        });
    }
}

