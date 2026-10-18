/// Готовность сервиса: может ли он выполнить доменный вызов, то есть отвечает ли
/// его база. Liveness — отдельный вопрос, и базу он не спрашивает: его держит
/// проверка `self` из ServiceDefaults с тегом `live`.
module Meetups.Infrastructure.Readiness

open System
open Microsoft.Extensions.Diagnostics.HealthChecks
open Npgsql

/// Тег проверок, из которых складывается готовность.
[<Literal>]
let Tag = "ready"

/// Тег liveness-проверки ServiceDefaults. Строка чужая, поэтому названа здесь
/// один раз, а не разбросана по composition root.
[<Literal>]
let LiveTag = "live"

/// Предел проверки меньше дедлайна пробы AppHost в три секунды: иначе вместо
/// NOT_SERVING проба получила бы DeadlineExceeded и назвала бы причину хуже.
let Timeout = TimeSpan.FromSeconds 2.

/// Открывает соединение из пула сервиса и выполняет `select 1`. Любой отказ —
/// неготовность: сервис с такой базой доменный вызов не выполнит, какой бы ни была
/// причина.
type DatabaseReadiness(source: NpgsqlDataSource) =
    interface IHealthCheck with
        member _.CheckHealthAsync(_, cancellationToken) =
            task {
                try
                    use! connection = source.OpenConnectionAsync(cancellationToken)
                    use command = connection.CreateCommand()
                    command.CommandText <- "select 1"
                    let! _ = command.ExecuteScalarAsync(cancellationToken)
                    return HealthCheckResult.Healthy()
                with error ->
                    return HealthCheckResult.Unhealthy("database unavailable", error)
            }
