module Meetups.Program

[<EntryPoint>]
let main args =
    let app = Meetups.Host.build args
    app.Run()
    0
