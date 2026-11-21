#!/usr/bin/env sh
# Fixture cases for tools/delivery/check-facts.sh: a complete report passes,
# and each fact taken out of it fails by its own name.

set -eu

root=$(git rev-parse --show-toplevel)
check="$root/tools/delivery/check-facts.sh"
failed=0
cases=0

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

mkdir -p "$scratch/.work/PER-1"
printf '# PER-1\n\nПостановка дословно.\n' > "$scratch/.work/PER-1/recon.md"

cat > "$scratch/complete.md" << 'EOF'
Pull request: https://github.com/Solguficky/solguficky-hub/pull/731
Гейт: just verify-changed — check-agent-tools check-mcp; EXIT=0
Ревью: ось стандартов — 1 находка, исправлена; ось спецификации — чисто; ось корректности — чисто.
Внешнее ревью: Codex, находок нет.
Чекпоинт: не сработал. Jev P(да)=0.12 | Clef P(да)=0.20 | вопрос plan@3
Ручной гейт: имя файла — решено сам, источник: задача. Jev P(да)=0.90 | Clef P(да)=0.85 | вопрос decided@3
EOF

# expect NAME CODE NEEDLE REPORT [ID]
expect() {
    name=$1 code=$2 needle=$3 report=$4 id=${5:-PER-1}
    cases=$((cases + 1))
    output=$(DELIVERY_ROOT="$scratch" sh "$check" "$id" "$report" 2>&1) && status=0 || status=$?
    if [ "$status" -ne "$code" ]; then
        echo "$name: expected exit $code, got $status:" >&2
        printf '%s\n' "$output" >&2
        failed=1
    elif ! printf '%s\n' "$output" | grep -Fq -- "$needle"; then
        echo "$name: output does not contain '$needle':" >&2
        printf '%s\n' "$output" >&2
        failed=1
    else
        echo "ok: $name"
    fi
}

# without NAME PATTERN — the complete report with the lines matching PATTERN
# removed.
without() {
    grep -v -- "$2" "$scratch/complete.md" > "$scratch/$1.md" || true
    echo "$scratch/$1.md"
}

expect 'a complete report passes' 0 'carries every fact' "$scratch/complete.md"

expect 'no pull request link' 1 "$(printf 'missing\tpull request')" "$(without nopr 'Pull request')"
expect 'no gate verdict' 1 "$(printf 'missing\tgate')" "$(without nogate 'EXIT=')"
expect 'no review axes' 1 "$(printf 'missing\treview: correctness')" "$(without noaxes '^Ревью')"
expect 'no external review' 1 "$(printf 'missing\texternal review')" "$(without noext 'Внешнее')"
{ grep -v 'Внешнее' "$scratch/complete.md"; echo '## Внешнее ревью'; } > "$scratch/heading.md"
expect 'an external review heading alone is not a result' 1 "$(printf 'missing\texternal review')" "$scratch/heading.md"
{ grep -v 'Внешнее' "$scratch/complete.md"; echo 'Внешнее ревью:'; } > "$scratch/emptyext.md"
expect 'an external review line without a result' 1 "$(printf 'missing\texternal review')" "$scratch/emptyext.md"
{ grep -v 'Внешнее' "$scratch/complete.md"; echo 'Внешнее ревью не шло: codex не в PATH.'; } > "$scratch/norun.md"
expect 'an external review that did not run is a fact' 0 'carries every fact' "$scratch/norun.md"
expect 'no checkpoint observers' 1 "$(printf 'missing\tcheckpoint')" "$(without noplan 'plan@')"
expect 'no manual gate line' 1 "$(printf 'missing\tmanual gate')" "$(without nomanual 'decided@')"
expect 'no recon artifact' 1 "$(printf 'missing\trecon')" "$scratch/complete.md" PER-2

{ grep -v 'decided@' "$scratch/complete.md"; echo 'Ручной гейт: решений гейта не было.'; } > "$scratch/nodecisions.md"
expect 'no decisions is a fact too' 0 'carries every fact' "$scratch/nodecisions.md"
{ grep -v 'EXIT=' "$scratch/complete.md"; echo 'Гейт: гейт не оценил изменение — нет Docker.'; } > "$scratch/notassessed.md"
expect 'a gate that did not assess is named, not hidden' 0 'carries every fact' "$scratch/notassessed.md"

expect 'not a task id' 2 'not a task id' "$scratch/complete.md" PER
expect 'no report file' 2 'no report at' "$scratch/absent.md"

if [ "$failed" -ne 0 ]; then
    exit 1
fi
echo "check-facts: all $cases fixture cases pass"
