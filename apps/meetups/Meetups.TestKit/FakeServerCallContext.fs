namespace Meetups.TestKit

open System
open System.Collections.Generic
open System.Threading
open System.Threading.Tasks
open Grpc.Core

/// Минимальный ServerCallContext для тестов границы без хоста.
///
/// Пакетного помощника в этой линии grpc-dotnet нет, а базовый класс абстрактный,
/// поэтому контекст собирается здесь. Он отвечает ровно на то, что читает
/// граница: имя метода, заголовки и токен отмены.
type FakeServerCallContext(method: string, cancellationToken: CancellationToken, deadline: DateTime, headers: Metadata)
    =
    inherit ServerCallContext()

    let mutable status = Status.DefaultSuccess
    let mutable writeOptions = WriteOptions()

    new(method: string) =
        FakeServerCallContext(method, CancellationToken.None, DateTime.UtcNow.AddMinutes 1.0, Metadata())

    new(method: string, cancellationToken: CancellationToken) =
        FakeServerCallContext(method, cancellationToken, DateTime.UtcNow.AddMinutes 1.0, Metadata())

    new(method: string, cancellationToken: CancellationToken, deadline: DateTime) =
        FakeServerCallContext(method, cancellationToken, deadline, Metadata())

    new(method: string, headers: Metadata) =
        FakeServerCallContext(method, CancellationToken.None, DateTime.UtcNow.AddMinutes 1.0, headers)

    override _.MethodCore = method
    override _.HostCore = "localhost"
    override _.PeerCore = "ipv4:127.0.0.1:0"
    override _.DeadlineCore = deadline
    override _.RequestHeadersCore = headers
    override _.CancellationTokenCore = cancellationToken
    override _.ResponseTrailersCore = Metadata()

    override _.StatusCore
        with get () = status
        and set value = status <- value

    override _.WriteOptionsCore
        with get () = writeOptions
        and set value = writeOptions <- value

    override _.AuthContextCore = AuthContext(null, Dictionary<string, List<AuthProperty>>())

    override _.CreatePropagationTokenCore(_options) = null
    override _.WriteResponseHeadersAsyncCore(_headers) = Task.CompletedTask
