/// The slice has no server yet. This module exists so that the reference from the F#
/// library to the generated contracts project is compiled and observable, not merely
/// declared in the .fsproj.
module Meetups.ContractSurface

open Meetups.V1

/// Fully qualified gRPC service name, "<package>.<service>".
let serviceFullName = MeetupsService.Descriptor.FullName
