module Meetups.IntegrationTests.Infrastructure.AuthenticatedClient

open Grpc.Core
open Grpc.Core.Interceptors
open Grpc.Net.Client
open Meetups.V1

[<Literal>]
let BotToken = "meetups-test-bot-token"

[<Literal>]
let NotificationsToken = "meetups-test-notifications-token"

[<Literal>]
let AuctionToken = "meetups-test-auction-token"

[<Literal>]
let OwnToken = "meetups-test-own-token"

let configuration =
    [|
        $"--MEETUPS_CALLER_TOKEN_HUB_BOT={BotToken}"
        $"--MEETUPS_CALLER_TOKEN_NOTIFICATIONS={NotificationsToken}"
        $"--MEETUPS_CALLER_TOKEN_AUCTION={AuctionToken}"
        $"--MEETUPS_SERVICE_TOKEN={OwnToken}"
    |]

/// Тест выбирает вызывающего явно; пользовательские RPC по умолчанию идут ботом.
/// Явный authorization не заменяется: отрицательные тесты предъявляют его сами.
let presenting (channel: GrpcChannel) token =
    let invoker =
        channel.Intercept(fun (headers: Metadata) ->
            if isNull (headers.GetValue "authorization") then
                headers.Add("authorization", $"Bearer {token}")

            headers
        )

    MeetupsService.MeetupsServiceClient invoker

let bot channel = presenting channel BotToken
let notifications channel = presenting channel NotificationsToken
