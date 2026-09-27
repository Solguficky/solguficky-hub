#!/usr/bin/env sh
# Fixture cases for tools/apphost/check-config.py.
#
# The live aspire.config.json is one happy path and cannot show that the check
# fails where it must. So each case gets its own tree with a config and a
# project, and the failures must name the path that is wrong.

set -eu

root=$(git rev-parse --show-toplevel)
check="$root/tools/apphost/check-config.py"
python=${PYTHON:-python3}
failed=0
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

apphost_element='<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.5.3" />
</Project>'
apphost_attribute='<Project Sdk="Microsoft.NET.Sdk;Aspire.AppHost.Sdk/13.5.3">
</Project>'
apphost_import='<Project>
  <Import Project="Sdk.props" Sdk="aspire.apphost.sdk" Version="13.5.3" />
</Project>'
plain_project='<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>
</Project>'
# MSBuild does not evaluate <ProjectExtensions>, so this Sdk declares nothing
nested_sdk='<Project Sdk="Microsoft.NET.Sdk">
  <ProjectExtensions><Sdk Name="Aspire.AppHost.Sdk" /></ProjectExtensions>
</Project>'

# tree NAME CONFIG_PATH [PROJECT_CONTENT] - a tree whose config names
# CONFIG_PATH and whose infra/apphost/AppHost/AppHost.csproj holds the content
tree() {
    work="$scratch/$1"
    mkdir -p "$work/infra/apphost/AppHost"
    printf '{\n  "appHost": {\n    "path": "%s"\n  }\n}\n' "$2" > "$work/aspire.config.json"
    if [ -n "${3:-}" ]; then
        printf '%s\n' "$3" > "$work/infra/apphost/AppHost/AppHost.csproj"
    fi
    echo "$work"
}

run_check() {
    (
        cd "$1" || exit 1
        "$python" "$check" 2>&1
    )
}

assert_fails() {
    name=$1
    needle=$2
    work=$3
    output=$(run_check "$work") && status=0 || status=$?
    if [ "$status" -eq 0 ]; then
        echo "expected $name to fail, it passed: $output" >&2
        failed=1
    elif ! printf '%s\n' "$output" | grep -Fq -- "$needle"; then
        echo "expected $name to name $needle: $output" >&2
        failed=1
    else
        echo "ok: $name"
    fi
}

assert_passes() {
    name=$1
    work=$2
    output=$(run_check "$work") && status=0 || status=$?
    if [ "$status" -ne 0 ]; then
        echo "expected $name to pass: $output" >&2
        failed=1
    else
        echo "ok: $name"
    fi
}

good=infra/apphost/AppHost/AppHost.csproj

assert_passes "Sdk element" "$(tree element "$good" "$apphost_element")"
assert_passes "Sdk attribute" "$(tree attribute "$good" "$apphost_attribute")"
assert_fails "typo in the path" "infra/apphost/AppHots/AppHost.csproj" \
    "$(tree typo infra/apphost/AppHots/AppHost.csproj "$apphost_element")"
assert_fails "missing project" "$good" "$(tree missing "$good")"
assert_fails "project without Aspire.AppHost.Sdk" "not an AppHost" \
    "$(tree plain "$good" "$plain_project")"
assert_fails "path outside the repository" "leaves the repository" \
    "$(tree outside ../AppHost.csproj "$apphost_element")"
assert_passes "Import Sdk, name in another case" "$(tree import "$good" "$apphost_import")"
assert_fails "Sdk nested below Project" "not an AppHost" \
    "$(tree nested "$good" "$nested_sdk")"
# CI checks out on a case-sensitive file system
assert_fails "path in another case" "infra/apphost/apphost/AppHost.csproj" \
    "$(tree case infra/apphost/apphost/AppHost.csproj "$apphost_element")"

work=$(tree props infra/apphost/AppHost/AppHost.props)
printf '%s\n' "$apphost_element" > "$work/infra/apphost/AppHost/AppHost.props"
assert_fails "not a .csproj" "not a .csproj" "$work"

# A Windows editor may save the config with a BOM; .NET reads it fine
work=$(tree bom "$good" "$apphost_element")
printf '\357\273\277' | cat - "$work/aspire.config.json" > "$work/bom.json"
mv "$work/bom.json" "$work/aspire.config.json"
assert_passes "config with a UTF-8 BOM" "$work"

work="$scratch/nokey"
mkdir -p "$work"
printf '{ "appHost": {} }\n' > "$work/aspire.config.json"
assert_fails "no appHost.path" "appHost.path is missing" "$work"

assert_passes "repository aspire.config.json" "$root"

if [ "$failed" -ne 0 ]; then
    exit 1
fi
echo "check-config: all fixture cases pass"
