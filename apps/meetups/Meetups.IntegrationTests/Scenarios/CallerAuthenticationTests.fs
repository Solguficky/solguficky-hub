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

    [<Fact>]
    member _.``When any caller asks enumeration expect UNAUTHENTICATED``() =
        let callers =
            [
                MeetupsService.MeetupsServiceClient host.Channel
                AuthenticatedClient.bot host.Channel
                AuthenticatedClient.notifications host.Channel
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

        test <@ statuses = List.replicate 4 (Some StatusCode.Unauthenticated) @>

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
