namespace Notifications.Auction;

/// <summary>
/// Оценка, сколько лот финала протянет (ADR-063, дополнение 2026-10-20):
/// среднее по лотам, которые в этом финале уже прошли, а пока их нет —
/// запасная оценка по программе недели.
/// </summary>
/// <remarks>
/// Оценка, а не обещание: длительность лота знает только ведущий, а порядок
/// финала известен заранее. Человеку полезно знать порядок, а не точное время.
/// </remarks>
public static class FinalEstimate
{
    /// <summary>
    /// Запасная оценка: 40-60 минут на 6-8 лотов — около 7 минут на лот.
    /// </summary>
    public const int FallbackMinutes = 7;

    /// <summary>
    /// Минуты на лот по уже прошедшим лотам финала. Одного лота для среднего
    /// мало: пока прошёл один лот, его длительность ещё не известна.
    /// </summary>
    /// <remarks>
    /// Среднее округляется вниз: обещать больше, чем лот протянет на самом деле,
    /// хуже, чем обещать меньше, — человек придёт раньше и подождёт.
    /// </remarks>
    public static int Minutes(IReadOnlyList<DateTimeOffset> activations)
    {
        if (activations.Count < 2)
        {
            return FallbackMinutes;
        }

        var span = activations[^1] - activations[0];
        var average = span.TotalMinutes / (activations.Count - 1);
        return (int)Math.Max(1, Math.Floor(average));
    }
}
