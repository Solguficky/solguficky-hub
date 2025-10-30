namespace AuctionService.Infrastructure.Persistence;

using System.ComponentModel.DataAnnotations;

public class LotEntity
{
    [Key]
    public int Id { get; set; }

    [Required]
    [MaxLength(26)]
    public string AuctionId { get; set; } = string.Empty;

    [Required]
    [MaxLength(500)]
    public string Title { get; set; } = string.Empty;

    [MaxLength(5000)]
    public string Description { get; set; } = string.Empty;

    [Required]
    public double StartingPrice { get; set; }

    [Required]
    public double MinBidStep { get; set; }

    [MaxLength(1000)]
    public string ImageUrl { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? UpdatedAt { get; set; }
}

