using Notifications.V1;

namespace Notifications.Domain;

/// <summary>Что делать с перебитием или ответом своей автоставки по настройке получателя.</summary>
public abstract record OutbidDecision
{
    /// <summary>Сообщить сразу, как до настройки.</summary>
    public sealed record Send : OutbidDecision;

    /// <summary>Не сообщать: участник о перебитиях и автоставке слышать не хочет.</summary>
    public sealed record Suppress : OutbidDecision;

    /// <summary>Свернуть в сводку окна этой длины, одного на участника по всем лотам.</summary>
    public sealed record Collect(TimeSpan Window) : OutbidDecision;
}

/// <summary>
/// Настройки уведомлений аукциона целиком (PER-539, PER-645): частота
/// перебитий и ответов автоставки, выключатель анонса финала и выключатель
/// перебитий в живом финале. Покупку и допуск не выключает ни одна из них.
/// </summary>
public sealed record AuctionPreferences(OutbidFrequency OutbidFrequency, bool FinalAnnouncements,
    bool LiveFinalOutbids);

/// <summary>
/// Словарь настройки перебитий: хранение, умолчание и решение. Правило живёт
/// здесь, а не в SQL, чтобы проверяться юнит-тестом без живой базы.
/// </summary>
public static class OutbidFrequencies
{
    /// <summary>Умолчание продукта для того, кто настройку не трогал (PER-513).</summary>
    public const OutbidFrequency Default = OutbidFrequency.Every;

    private static readonly IReadOnlyDictionary<OutbidFrequency, string> Stored =
        new Dictionary<OutbidFrequency, string>
        {
            [OutbidFrequency.Every] = "every",
            [OutbidFrequency.AtMostEvery5Minutes] = "at_most_every_5_minutes",
            [OutbidFrequency.AtMostEvery15Minutes] = "at_most_every_15_minutes",
            [OutbidFrequency.AtMostEvery60Minutes] = "at_most_every_60_minutes",
            [OutbidFrequency.Off] = "off",
        };

    private static readonly IReadOnlyDictionary<string, OutbidFrequency> ByStorage =
        Stored.ToDictionary(pair => pair.Value, pair => pair.Key, StringComparer.Ordinal);

    /// <summary>Значение, которое команда может записать: всё, кроме неизвестного.</summary>
    public static bool IsKnown(OutbidFrequency frequency) => Stored.ContainsKey(frequency);

    public static string Storage(OutbidFrequency frequency) =>
        Stored.TryGetValue(frequency, out var stored)
            ? stored
            : throw new ArgumentOutOfRangeException(nameof(frequency), frequency, "unknown outbid frequency");

    public static OutbidFrequency FromStorage(string stored) =>
        ByStorage.TryGetValue(stored, out var frequency)
            ? frequency
            : throw new ArgumentOutOfRangeException(nameof(stored), stored, "unknown stored outbid frequency");

    /// <summary>
    /// Умолчание выключателя перебитий в живом финале: в зале «перебили» —
    /// шум, и молчат они, пока человек их не включил (PER-645).
    /// </summary>
    public const bool LiveFinalDefault = false;

    /// <summary>
    /// Решение в живом финале: частота здесь не действует — лот в зале живёт
    /// минуты, и сводка пришла бы после продажи. Включивший получает каждое
    /// событие, остальные — ни одного (PER-645).
    /// </summary>
    public static OutbidDecision DecideLiveFinal(bool? enabled) =>
        enabled ?? LiveFinalDefault ? new OutbidDecision.Send() : new OutbidDecision.Suppress();

    /// <summary>Решение по заданному значению; отсутствие строки — умолчание.</summary>
    public static OutbidDecision Decide(OutbidFrequency? frequency) =>
        (frequency ?? Default) switch
        {
            OutbidFrequency.Every => new OutbidDecision.Send(),
            OutbidFrequency.AtMostEvery5Minutes => new OutbidDecision.Collect(TimeSpan.FromMinutes(5)),
            OutbidFrequency.AtMostEvery15Minutes => new OutbidDecision.Collect(TimeSpan.FromMinutes(15)),
            OutbidFrequency.AtMostEvery60Minutes => new OutbidDecision.Collect(TimeSpan.FromMinutes(60)),
            OutbidFrequency.Off => new OutbidDecision.Suppress(),
            var unknown => throw new ArgumentOutOfRangeException(nameof(frequency), unknown, "unknown outbid frequency"),
        };
}
