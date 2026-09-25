using Notifications.Replica;
using Notifications.V1;

namespace Notifications.Facts;

/// <summary>
/// Что изменилось в сходке: сравнение снимка события с репликой. Чистая
/// функция, поэтому каждое правило проверяется на L0.
/// </summary>
/// <remarks>
/// Событие «изменена» не говорит, что именно поменялось, — только что верно
/// теперь (ADR-031). Разницу Notifications вычисляет сам, и она же делит
/// одну категорию продукта «изменение сведений или состояния» на два вида
/// факта: аспекты сведений и аспекты состояния.
///
/// Автор и отметка первой публикации аспектами не являются: ни то, ни другое
/// человек не видит как изменение сходки. Материалов и момента отложенной
/// публикации в реплике нет, поэтому их поводы дают пустую разницу — и это
/// верно: у материала свой факт, а отложенная публикация людям не видна.
/// </remarks>
public static class MeetupDiff
{
    /// <summary>Аспекты сведений: то, что организатор пишет о сходке.</summary>
    public static readonly IReadOnlySet<MeetupAspect> Information = new HashSet<MeetupAspect>
    {
        MeetupAspect.Title,
        MeetupAspect.Description,
        MeetupAspect.Venue,
        MeetupAspect.Kind,
        MeetupAspect.CalendarLink,
        MeetupAspect.Schedule,
    };

    /// <summary>Аспекты состояния: отмена, проведение, снятие и возврат.</summary>
    public static readonly IReadOnlySet<MeetupAspect> State = new HashSet<MeetupAspect>
    {
        MeetupAspect.Lifecycle,
        MeetupAspect.Visibility,
    };

    /// <summary>
    /// Аспекты, значение которых в <paramref name="after" /> отличается от
    /// <paramref name="before" />, в порядке перечисления контракта. Пустой
    /// список означает, что поводом событие не является.
    /// </summary>
    public static IReadOnlyList<MeetupAspect> Between(MeetupReplicaState before, MeetupReplicaState after)
    {
        var changed = new List<MeetupAspect>();

        Add(changed, MeetupAspect.Title, before.Title != after.Title);
        Add(changed, MeetupAspect.Description, before.Description != after.Description);
        Add(changed, MeetupAspect.Venue, before.Venue != after.Venue);
        Add(changed, MeetupAspect.Kind, before.Kind != after.Kind);
        Add(changed, MeetupAspect.CalendarLink, before.CalendarLink != after.CalendarLink);

        // Перенос отдельного типа не имеет: он такой же аспект, как остальные,
        // и узнаётся по расписанию целиком — форма, точность, даты и время.
        Add(changed, MeetupAspect.Schedule, before.Schedule != after.Schedule);
        Add(changed, MeetupAspect.Lifecycle, before.Lifecycle != after.Lifecycle);
        Add(changed, MeetupAspect.Visibility, before.Visibility != after.Visibility);

        return changed;
    }

    private static void Add(List<MeetupAspect> changed, MeetupAspect aspect, bool differs)
    {
        if (differs)
        {
            changed.Add(aspect);
        }
    }
}
