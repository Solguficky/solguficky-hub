namespace Meetups.IntegrationTests.Scenarios

open System
open Grpc.Core
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// Настоящий transport и production composition root, без базы: ни один из
/// отказов не должен добраться до SQL. Допущенный вызов проверяется ответом
/// среза, а не искусственно успешным handler.
type CallerAuthenticationTests(host: MeetupsHostFixture) =
    interface IClassFixture<MeetupsHostFixture>

    [<Fact>]
    member _.``When a command has no token or the Notifications token expect UNAUTHENTICATED``() =
        let bare = MeetupsService.MeetupsServiceClient host.Channel
        let notifications = AuthenticatedClient.notifications host.Channel

        let statuses =
            [ bare; notifications ]
            |> List.map (fun client ->
                Rpc.codeOf (fun () ->
                    client.CreateMeetupDraft(CreateMeetupDraftRequest())
                    |> ignore
                )
            )

        test <@ statuses = List.replicate 2 (Some StatusCode.Unauthenticated) @>

    [<Fact>]
    member _.``When Notifications asks authority expect a substantive reply from the slice``() =
        let client = AuthenticatedClient.notifications host.Channel

        let request =
            CheckMeetupAuthorityRequest(
                Id = "0199c0de-0000-7000-8000-000000000001",
                IdentityId = "0199c0de-0000-7000-8000-00000000000a"
            )

        request.AcceptedRelations.Add MeetupRelation.CommunityAdministrator
        let headers = Metadata()
        headers.Add("x-request-id", "auth-notifications-authority")

        let status =
            Rpc.codeOf (fun () ->
                client.CheckMeetupAuthority(request, headers)
                |> ignore
            )

        let frame =
            host.Records
            |> List.find (fun record -> record.Fields.TryFind "request_id" = Some "auth-notifications-authority")

        test
            <@
                status = Some StatusCode.Unavailable
                && frame.Fields.TryFind "caller" = Some "notifications"
                && not (frame.Fields.ContainsKey "caller_refusal")
            @>

    /// Вопрос Identity перед ником в карточке допускает одного вызывающего: Identity.
    /// Допущенный вызов проверяется ответом среза (запрос неверной формы отвергает
    /// разбор), а не успехом заглушки; остальные не доходят до среза.
    [<Fact>]
    member _.``When Identity confirms a contact expect the slice to answer and every other caller UNAUTHENTICATED``() =
        let status (client: MeetupsService.MeetupsServiceClient) =
            Rpc.codeOf (fun () ->
                client.ConfirmMeetupContact(ConfirmMeetupContactRequest())
                |> ignore
            )

        let others =
            [
                MeetupsService.MeetupsServiceClient host.Channel
                AuthenticatedClient.bot host.Channel
                AuthenticatedClient.notifications host.Channel
                AuthenticatedClient.auction host.Channel
            ]
            |> List.map status

        test <@ status (AuthenticatedClient.identity host.Channel) = Some StatusCode.InvalidArgument @>
        test <@ others = List.replicate 4 (Some StatusCode.Unauthenticated) @>

    [<Fact>]
    member _.``When Identity asks any other method expect UNAUTHENTICATED``() =
        let identity = AuthenticatedClient.identity host.Channel

        let statuses =
            [
                fun () -> identity.GetMeetup(GetMeetupRequest()) |> ignore
                fun () ->
                    identity.CheckMeetupAuthority(CheckMeetupAuthorityRequest())
                    |> ignore
                fun () ->
                    identity.GetMeetupStanding(GetMeetupStandingRequest())
                    |> ignore
                fun () ->
                    identity.ListMeetupStates(ListMeetupStatesRequest())
                    |> ignore
                fun () ->
                    identity.CreateMeetupDraft(CreateMeetupDraftRequest())
                    |> ignore
            ]
            |> List.map Rpc.codeOf

        test <@ statuses = List.replicate 5 (Some StatusCode.Unauthenticated) @>

    [<Fact>]
    member _.``When any caller asks enumeration expect UNAUTHENTICATED``() =
        let callers =
            [
                MeetupsService.MeetupsServiceClient host.Channel
                AuthenticatedClient.bot host.Channel
                AuthenticatedClient.notifications host.Channel
                AuthenticatedClient.identity host.Channel
                AuthenticatedClient.presenting host.Channel AuthenticatedClient.OwnToken
            ]

        let statuses =
            callers
            |> List.map (fun client ->
                Rpc.codeOf (fun () ->
                    client.ListMeetupStates(ListMeetupStatesRequest())
                    |> ignore
                )
            )

        test <@ statuses = List.replicate 5 (Some StatusCode.Unauthenticated) @>

    [<Fact>]
    member _.``When a caller is refused expect one safe boundary record with the cause``() =
        let client = AuthenticatedClient.notifications host.Channel
        let headers = Metadata()
        headers.Add("x-request-id", "auth-notifications-command")

        Rpc.codeOf (fun () ->
            client.CreateMeetupDraft(CreateMeetupDraftRequest(), headers)
            |> ignore
        )
        |> ignore

        let frames =
            host.Records
            |> List.filter (fun record -> record.Fields.TryFind "request_id" = Some "auth-notifications-command")

        let frame = List.exactlyOne frames

        test
            <@
                frame.Fields.TryFind "caller" = Some "notifications"
                && frame.Fields.TryFind "caller_refusal" = Some "not_declared"
                && frame.Fields.TryFind "grpc_code" = Some "Unauthenticated"
                && frame.Fields.TryFind "error_category" = Some "authorization"
                && frame.Exception.IsNone
            @>

        test
            <@
                frame.Fields
                |> Map.forall (fun _ value -> not (value.Contains AuthenticatedClient.NotificationsToken))
            @>

    [<Fact>]
    member _.``When token configuration is incomplete or ambiguous expect host construction to fail``() =
        let overrides =
            [
                "--MEETUPS_CALLER_TOKEN_HUB_BOT="
                "--MEETUPS_CALLER_TOKEN_NOTIFICATIONS="
                "--MEETUPS_CALLER_TOKEN_AUCTION="
                "--MEETUPS_CALLER_TOKEN_IDENTITY="
                $"--MEETUPS_CALLER_TOKEN_IDENTITY={AuthenticatedClient.BotToken}"
                $"--MEETUPS_CALLER_TOKEN_NOTIFICATIONS={AuthenticatedClient.BotToken}"
                "--MEETUPS_SERVICE_TOKEN="
                $"--MEETUPS_SERVICE_TOKEN={AuthenticatedClient.BotToken}"
            ]

        let rejected =
            overrides
            |> List.map (fun value ->
                try
                    use app =
                        Meetups.Host.build (
                            Array.append
                                AuthenticatedClient.configuration
                                [|
                                    "--MEETUPS_COMMUNITY_TIME_ZONE=Europe/Moscow"
                                    value
                                |]
                        )

                    false
                with :? InvalidOperationException as ex ->
                    not (ex.Message.Contains AuthenticatedClient.BotToken)
            )

        test <@ rejected |> List.forall id @>
