using System.Security.Cryptography;
using System.Text;

namespace Notifications.Auction;

/// <summary>
/// Аукцион сходки по правилу контракта Auction (integration.md, «Аукцион у
/// сходки»): UUIDv5 от канонической строки <c>meetup_id</c> в UTF-8 в
/// неизменном пространстве имён. Объявление аукциона (PER-764) называет
/// сходку, а аукцион выводит сам: связи «аукцион — сходка» у сервиса нет, а
/// источник правила один.
/// </summary>
public static class AuctionOfMeetup
{
    /// <summary>Пространство имён из контракта. Не меняется никогда, как и у Auction.</summary>
    public static readonly Guid Namespace = Guid.Parse("83a6d0b2-84ed-4444-a77b-dd0338dc84a4");

    public static Guid Of(Guid meetupId)
    {
        var name = Encoding.UTF8.GetBytes(meetupId.ToString("D"));
        var input = new byte[16 + name.Length];
        Namespace.TryWriteBytes(input.AsSpan(0, 16), bigEndian: true, out _);
        name.CopyTo(input, 16);

        // SHA-1 здесь не защита, а часть правила RFC 9562 для версии 5.
#pragma warning disable CA5350
        var hash = SHA1.HashData(input);
#pragma warning restore CA5350
        hash[6] = (byte)((hash[6] & 0x0f) | 0x50);
        hash[8] = (byte)((hash[8] & 0x3f) | 0x80);

        return new Guid(hash.AsSpan(0, 16), bigEndian: true);
    }
}
