namespace Meetups.IntegrationTests.Scenarios

open System
open Grpc.Core
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// The negative half of the first slice, exercised through the real gRPC and
/// PostgreSQL boundaries. Keeping the scenarios together makes the contract
/// inventory below the guard against a newly introduced read bypass.
type HiddenMeetupReadTests() =

    let administrator () =
        let viewer = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000a")
        viewer.GlobalRoles.Add Identity.V1.GlobalRole.Admin
        viewer

    let ordinary () = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000c")

    let createDraft (client: MeetupsService.MeetupsServiceClient) =
        let key = (Guid.CreateVersion7()).ToString "D"

        client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = administrator (), Id = key))
        |> ignore

        key

    let notFound (action: unit -> unit) = Rpc.codeOf action

    [<Fact>]
    member _.``Every contract read operation has a hidden-meetup scenario``() =
        let writeOperations =
            set
                [
                    "CreateMeetupDraft"
                    "ChangeMeetupAttributes"
                    "SetMeetupSchedule"
                    "PublishMeetup"
                ]

        let contractReadOperations =
            MeetupsService.Descriptor.Methods
            |> Seq.map _.Name
            |> Seq.filter (writeOperations.Contains >> not)
            |> Set.ofSeq

        let operationsCoveredByThisSuite = set [ "ListVisibleMeetups"; "GetMeetup" ]

        test <@ contractReadOperations = operationsCoveredByThisSuite @>

    [<Fact>]
    member _.``The list does not expose a hidden meetup to an ordinary viewer``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId = createDraft client

        let returnedIds =
            client.ListVisibleMeetups(ListVisibleMeetupsRequest(Viewer = ordinary ())).Meetups
            |> Seq.map _.Id
            |> Set.ofSeq

        test <@ not (returnedIds.Contains hiddenId) @>

    [<Fact>]
    member _.``Reading by identifier does not expose a hidden meetup to an ordinary viewer``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId = createDraft client

        let actual =
            notFound (fun () ->
                client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = hiddenId))
                |> ignore
            )

        let denial =
            live.Records
            |> List.tryFind (fun entry -> entry.Fields.TryFind "denial_reason" = Some "not_visible")

        test <@ actual = Some StatusCode.NotFound && denial.IsSome @>

    [<Fact>]
    member _.``A direct-link lookup answers like a lookup of a missing meetup``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId = createDraft client

        let lookup meetupId =
            try
                // A Telegram deep link is resolved to this same GetMeetup call.
                client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = meetupId))
                |> ignore

                None
            with :? RpcException as refused ->
                Some refused.Status

        let hidden = lookup hiddenId
        let missing = lookup ((Guid.CreateVersion7()).ToString "D")

        test
            <@
                hidden = missing
                && missing = Some(Status(StatusCode.NotFound, "meetup not found"))
            @>
