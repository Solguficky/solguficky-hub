#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$root/apps/identity"
go install google.golang.org/protobuf/cmd/protoc-gen-go
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc
PATH="$(go env GOPATH)/bin:$PATH"
export PATH
cd "$root"
buf generate --template apps/identity/buf.gen.yaml
