namespace Meetups.Observability

open System
open Grpc.Core
open Meetups

/// Сквозные значения, которые рождаются на Telegram-краю и приходят транспортными
/// метаданными gRPC. Читаются одной функцией и записью границы, и диспетчером, который
/// передаёт `request_id` срезу для журнала (PER-227): разойдись они — лог границы и
/// строка журнала называли бы одну команду разными id.
module IncomingMetadata =

    /// Пустой заголовок не превращается в значение: logging.md требует опускать то,
    /// что граница не получила.
    let header (name: string) (context: ServerCallContext) =
        context.RequestHeaders
        |> Seq.tryPick (fun entry ->
            if
                String.Equals(entry.Key, name, StringComparison.OrdinalIgnoreCase)
                && not (String.IsNullOrWhiteSpace entry.Value)
            then
                Some entry.Value
            else
                None
        )

    /// Значение, которое не укладывается в `RequestId`, отбрасывается и в логе, и в
    /// журнале одинаково — см. `RequestId.create`.
    let requestId (context: ServerCallContext) : RequestId option =
        header "x-request-id" context
        |> Option.bind RequestId.create

    let useCase (context: ServerCallContext) = header "x-use-case" context
