namespace Meetups.Transport

open System
open System.Security.Cryptography
open System.Text

/// Вызывающий — процесс, а не человек из тела запроса (ADR-056).
[<RequireQualifiedAccess>]
type Caller =
    | HubBot
    | Notifications

    member this.Node =
        match this with
        | Caller.HubBot -> "hub-bot"
        | Caller.Notifications -> "notifications"

    member this.TokenVariable =
        "MEETUPS_CALLER_TOKEN_"
        + this.Node.ToUpperInvariant().Replace('-', '_')

/// Digest имеет фиксированную длину; сравниваются все строки без раннего выхода.
/// Значения токенов и их digest не выходят из таблицы и не попадают в диагностику.
type CallerTable private (rows: (Caller * byte array) list) =
    static let digest (token: string) = SHA256.HashData(Encoding.UTF8.GetBytes token)

    member _.Identify(token: string) =
        let presented = digest token
        let mutable found = None

        for caller, expected in rows do
            if CryptographicOperations.FixedTimeEquals(presented, expected) then
                found <- Some caller

        found

    static member FromConfiguration(read: string -> string, declared: Set<Caller>) =
        let tokens =
            declared
            |> Set.toList
            |> List.map (fun caller ->
                let token =
                    read caller.TokenVariable
                    |> Option.ofObj
                    |> Option.defaultValue ""

                caller, token.Trim()
            )

        for caller, token in tokens do
            if String.IsNullOrEmpty token then
                invalidOp $"{caller.TokenVariable} is not set"

        tokens
        |> List.groupBy snd
        |> List.iter (fun (_, shared) ->
            if shared.Length > 1 then
                let names =
                    shared
                    |> List.map (fst >> _.Node)
                    |> String.concat " and "

                invalidOp $"caller tokens are equal for {names}"
        )

        CallerTable(
            tokens
            |> List.map (fun (caller, token) -> caller, digest token)
        )

/// Свой токен обязателен и не может совпадать с токеном вызывающего (PER-417).
module ServiceToken =
    [<Literal>]
    let Variable = "MEETUPS_SERVICE_TOKEN"

    let fromConfiguration (read: string -> string) (callers: CallerTable) =
        let token =
            read Variable
            |> Option.ofObj
            |> Option.defaultValue ""
            |> _.Trim()

        if String.IsNullOrEmpty token then
            invalidOp $"{Variable} is not set"

        match callers.Identify token with
        | Some caller -> invalidOp $"{Variable} equals the caller token of {caller.Node}"
        | None -> token
