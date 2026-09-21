using Dapper;
using Notifications.Grains;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>
/// Доступ к таблице активаций. Dapper поверх Npgsql — рекомендованный набор
/// <c>docs/standards/data/postgresql.md</c>.
/// </summary>
public sealed class GrainActivationStore(NpgsqlDataSource source)
{
    private const string RecordSql = """
        INSERT INTO grain_activation (grain_key, silo, activations, observed_at)
        VALUES (@GrainKey, @Silo, 1, @ObservedAt)
        ON CONFLICT (grain_key) DO UPDATE
        SET silo        = EXCLUDED.silo,
            activations = grain_activation.activations + 1,
            observed_at = EXCLUDED.observed_at
        RETURNING grain_key, silo, activations, observed_at;
        """;

    /// <summary>
    /// Отмечает активацию грина и возвращает накопленный счётчик. Счётчик и есть
    /// доказательство: вторая активация того же ключа после смерти хоста даёт 2,
    /// а не 1, и значит состояние пережило процесс, не будучи ни в одном
    /// storage provider Orleans.
    /// </summary>
    public async Task<ActivationRecord> Record(string grainKey, string silo, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var row = await connection.QuerySingleAsync<Row>(
            new CommandDefinition(
                RecordSql,
                new { GrainKey = grainKey, Silo = silo, ObservedAt = DateTime.UtcNow },
                cancellationToken: cancellationToken));

        return new ActivationRecord(
            row.grain_key,
            row.silo,
            row.activations,
            new DateTimeOffset(row.observed_at.ToUniversalTime()));
    }

    // Имена полей совпадают с колонками: Dapper сопоставляет по имени, и
    // переименование колонки должно ломать сборку здесь, а не поиск в рантайме.
    //
    // observed_at читается как DateTime, а не DateTimeOffset: Npgsql отображает
    // timestamptz именно так, и запись с DateTimeOffset Dapper материализовать
    // не может вовсе — падает на подборе конструктора. Перевод идёт через
    // ToUniversalTime, а не через SpecifyKind: второй переинтерпретирует Kind,
    // и смени Npgsql умолчание на Local — мгновение молча уехало бы на смещение.
    private sealed record Row(string grain_key, string silo, long activations, DateTime observed_at);
}
