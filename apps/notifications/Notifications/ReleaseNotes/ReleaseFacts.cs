using Notifications.Facts;
using Notifications.V1;

namespace Notifications.ReleaseNotes;

/// <summary>Сводка выпуска и её адресный факт; текста записей в них нет (ADR-069, п. 4).</summary>
public static class ReleaseFacts
{
    public const string SummaryType = "release_summary";
    public const string SummaryCauseKind = "release_summary";

    /// <summary>Категория сводки: «Новое в боте», только глобальная.</summary>
    public const NotificationCategory Category = NotificationCategory.ReleaseNotes;

    /// <summary>Сводка в форме контракта: тот же тип отвечает чтению и несёт факт.</summary>
    public static V1.ReleaseSummary Summary(StoredSummary summary)
    {
        var message = new V1.ReleaseSummary
        {
            SummaryId = summary.SummaryId.ToString("D"),
            SummarizedAt = NotificationFacts.Instant(summary.SummarizedAt),
        };
        message.RecordIds.AddRange(summary.RecordIds);
        return message;
    }

    /// <summary>Сводка одному получателю. Повод — сама сводка: она создаётся один раз.</summary>
    public static Notification Fact(Guid notificationId, Guid recipientId, StoredSummary summary, DateTimeOffset now,
        DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = recipientId.ToString(),
        CreatedAt = NotificationFacts.Instant(now),
        NotAfter = NotificationFacts.Instant(notAfter),
        Cause = new Cause { ReleaseSummaryId = summary.SummaryId.ToString("D") },
        ReleaseSummary = Summary(summary),
    };
}

/// <summary>Сводка, как её хранит сервис.</summary>
public sealed record StoredSummary(Guid SummaryId, DateTimeOffset SummarizedAt, IReadOnlyList<string> RecordIds);
