module Meetups.TestRpc

open System.Threading.Tasks
open Grpc.Core

/// GetAwaiter().GetResult(), а не Async.RunSynchronously: второй заворачивает
/// объявленный RpcException в AggregateException.
let codeOf (call: unit -> Task<'a>) =
    try
        call().GetAwaiter().GetResult() |> ignore
        None
    with :? RpcException as declined ->
        Some declined.StatusCode
