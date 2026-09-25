using System.Data;
using Dapper;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>
/// Соединение и транзакция, внутри которых идут и команда, и снимок, который
/// она возвращает.
/// </summary>
/// <remarks>
/// Тип существует, чтобы у хранилищ не было собственного соединения. Открой
/// каждое своё — ответ собрался бы из нескольких состояний базы: между записью
/// и чтением встал бы чужой коммит, и клиент получил бы успех на свою команду
/// вместе с чужим значением.
/// </remarks>
public sealed class UnitOfWork : IAsyncDisposable
{
    private readonly NpgsqlConnection connection;
    private readonly NpgsqlTransaction transaction;

    private UnitOfWork(NpgsqlConnection connection, NpgsqlTransaction transaction)
    {
        this.connection = connection;
        this.transaction = transaction;
    }

    /// <summary>Открывает соединение и транзакцию для одной операции.</summary>
    public static async Task<UnitOfWork> Begin(NpgsqlDataSource source, CancellationToken cancellationToken)
    {
        var connection = await source.OpenConnectionAsync(cancellationToken);

        try
        {
            // Read committed — умолчание PostgreSQL, и его здесь достаточно:
            // запись держит блокировку строки до конца транзакции, поэтому
            // чтение после неё видит собственное значение, а конкурент ждёт.
            // Более строгий уровень добавил бы отказ 40001 на обычной гонке
            // двух переключений, то есть поменял бы редкую неточность на отказ.
            var transaction = await connection.BeginTransactionAsync(
                IsolationLevel.ReadCommitted,
                cancellationToken);

            return new UnitOfWork(connection, transaction);
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    /// <summary>Фиксирует операцию. Не вызван — транзакция откатится при разборе.</summary>
    public Task Commit(CancellationToken cancellationToken) => transaction.CommitAsync(cancellationToken);

    /// <summary>Выполняет команду. Возвращает число затронутых строк.</summary>
    internal Task<int> Execute(string sql, object parameters, CancellationToken cancellationToken) =>
        connection.ExecuteAsync(
            new CommandDefinition(sql, parameters, transaction, cancellationToken: cancellationToken));

    internal Task<bool> Scalar(string sql, object parameters, CancellationToken cancellationToken) =>
        connection.ExecuteScalarAsync<bool>(
            new CommandDefinition(sql, parameters, transaction, cancellationToken: cancellationToken));

    internal async Task<IReadOnlyList<TRow>> Query<TRow>(
        string sql,
        object parameters,
        CancellationToken cancellationToken)
    {
        var rows = await connection.QueryAsync<TRow>(
            new CommandDefinition(sql, parameters, transaction, cancellationToken: cancellationToken));

        return rows.ToArray();
    }

    public async ValueTask DisposeAsync()
    {
        // Порядок важен: транзакция разбирается до соединения, иначе откат
        // незафиксированной операции пошёл бы по уже закрытому соединению.
        await transaction.DisposeAsync();
        await connection.DisposeAsync();
    }
}
