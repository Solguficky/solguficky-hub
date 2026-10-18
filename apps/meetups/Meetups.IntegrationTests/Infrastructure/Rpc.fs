/// Общее между сценариями границы: снять код объявленного отказа, не роняя тест.
/// Вынесено сюда после второго потребителя, а не заранее.
module Meetups.IntegrationTests.Infrastructure.Rpc

open Grpc.Core

/// Успех даёт None, объявленный отказ — свой код. Неожиданное исключение наружу не
/// глотается: тест, поймавший всё подряд, зеленел бы и на сломанном хосте.
let codeOf (call: unit -> unit) : StatusCode option =
    try
        call ()
        None
    with :? RpcException as declined ->
        Some declined.StatusCode
