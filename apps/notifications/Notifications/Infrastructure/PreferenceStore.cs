using Notifications.Domain;
using Notifications.V1;

namespace Notifications.Infrastructure;

/// <summary>
/// Доступ к таблице настроек категорий. Dapper поверх Npgsql — рекомендованный
/// набор <c>docs/standards/data/postgresql.md</c>.
/// </summary>
/// <remarks>
/// Соединение и транзакцию хранилище не открывает: их приносит
/// <see cref="UnitOfWork" />, потому что команда и снимок, который она
/// возвращает, обязаны быть одной единицей работы.
///
/// Хранилище отдаёт только то, что человек менял: действующее значение выводит
/// <see cref="EffectivePreference" />. Разделение не стилистическое — правило
/// продукта, которое здесь легко было бы растворить в SQL, проверяется
/// юнит-тестом без живой базы.
/// </remarks>
public sealed class PreferenceStore
{
    // Обе области одним запросом, а не двумя: глобальные значения и
    // переопределения у сходки читаются в один момент, и снимок не может
    // оказаться собранным из двух разных состояний базы.
    private const string ReadForMeetupSql = """
        SELECT category, enabled, meetup_id IS NULL AS is_global
        FROM notification_preference
        WHERE identity_id = @IdentityId AND (meetup_id IS NULL OR meetup_id = @MeetupId);
        """;

    private const string ReadGlobalSql = """
        SELECT category, enabled, true AS is_global
        FROM notification_preference
        WHERE identity_id = @IdentityId AND meetup_id IS NULL;
        """;

    // Целевой индекс называется предикатом: у частичного уникального индекса
    // вывод по одному списку колонок не проходит, потому что таких индексов на
    // таблице два и они различаются именно предикатом.
    private const string SetGlobalSql = """
        INSERT INTO notification_preference (identity_id, meetup_id, category, enabled, updated_at)
        VALUES (@IdentityId, NULL, @Category, @Enabled, @UpdatedAt)
        ON CONFLICT (identity_id, category) WHERE meetup_id IS NULL
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at;
        """;

    private const string SetMeetupSql = """
        INSERT INTO notification_preference (identity_id, meetup_id, category, enabled, updated_at)
        VALUES (@IdentityId, @MeetupId, @Category, @Enabled, @UpdatedAt)
        ON CONFLICT (identity_id, meetup_id, category) WHERE meetup_id IS NOT NULL
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at;
        """;

    private const string ClearMeetupSql = """
        DELETE FROM notification_preference
        WHERE identity_id = @IdentityId AND meetup_id = @MeetupId AND category = @Category;
        """;

    /// <summary>Глобальные настройки человека. Только заданные, без умолчаний.</summary>
    public async Task<IReadOnlyDictionary<NotificationCategory, bool>> ReadGlobal(
        UnitOfWork work,
        Guid identityId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<Row>(ReadGlobalSql, new { IdentityId = identityId }, cancellationToken);

        return Values(rows, global: true);
    }

    /// <summary>
    /// Обе области сразу: глобальные значения и переопределения у сходки.
    /// Отсутствие категории среди переопределений означает наследование.
    /// </summary>
    public async Task<MeetupScopeRows> ReadForMeetup(
        UnitOfWork work,
        Guid identityId,
        Guid meetupId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<Row>(
            ReadForMeetupSql,
            new { IdentityId = identityId, MeetupId = meetupId },
            cancellationToken);

        return new MeetupScopeRows(Values(rows, global: true), Values(rows, global: false));
    }

    /// <summary>Ставит глобальное значение категории.</summary>
    public Task SetGlobal(
        UnitOfWork work,
        Guid identityId,
        NotificationCategory category,
        bool enabled,
        CancellationToken cancellationToken) =>
        work.Execute(
            SetGlobalSql,
            new
            {
                IdentityId = identityId,
                Category = NotificationCategories.Storage(category),
                Enabled = enabled,
                UpdatedAt = DateTime.UtcNow,
            },
            cancellationToken);

    /// <summary>Ставит переопределение категории у сходки.</summary>
    public Task SetMeetupOverride(
        UnitOfWork work,
        Guid identityId,
        Guid meetupId,
        NotificationCategory category,
        bool enabled,
        CancellationToken cancellationToken) =>
        work.Execute(
            SetMeetupSql,
            new
            {
                IdentityId = identityId,
                MeetupId = meetupId,
                Category = NotificationCategories.Storage(category),
                Enabled = enabled,
                UpdatedAt = DateTime.UtcNow,
            },
            cancellationToken);

    /// <summary>
    /// Снимает переопределение: категория снова следует за глобальной настройкой.
    /// </summary>
    /// <remarks>
    /// Продуктового пути сюда сегодня нет: контракт PER-38 операции снятия не
    /// содержит, и <c>SetMeetupCategoryPreference</c> всегда создаёт
    /// переопределение. Операция существует как внутренняя, потому что
    /// наследование — свойство модели, а свойство без способа его вызвать
    /// нельзя проверить.
    /// </remarks>
    public Task ClearMeetupOverride(
        UnitOfWork work,
        Guid identityId,
        Guid meetupId,
        NotificationCategory category,
        CancellationToken cancellationToken) =>
        work.Execute(
            ClearMeetupSql,
            new
            {
                IdentityId = identityId,
                MeetupId = meetupId,
                Category = NotificationCategories.Storage(category),
            },
            cancellationToken);

    private static IReadOnlyDictionary<NotificationCategory, bool> Values(
        IReadOnlyList<Row> rows,
        bool global) =>
        rows.Where(row => row.is_global == global)
            .ToDictionary(row => NotificationCategories.FromStorage(row.category), row => row.enabled);

    // Имена полей совпадают с колонками: переименование колонки должно ломать
    // сборку здесь, а не поиск в рантайме. Тот же приём, что в GrainActivationStore.
    private sealed record Row(string category, bool enabled, bool is_global);
}

/// <summary>Заданные значения обеих областей, прочитанные одним запросом.</summary>
public sealed record MeetupScopeRows(
    IReadOnlyDictionary<NotificationCategory, bool> Global,
    IReadOnlyDictionary<NotificationCategory, bool> Overrides);
