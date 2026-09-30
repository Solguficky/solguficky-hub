"""Judge a `go test -json` log of Identity: fail on a skip and on a lost test.

Usage: check-test-log.py LOG THRESHOLD

`go test` exits 0 when a test is skipped and when a test file is not compiled
at all: a typo in `//go:build integration` drops a file that no other file
of the package refers to from every run without a trace (one that is referred
to breaks the package build loudly). Go has no flag for either case, so this
check reads the event stream and fails when

- any test, subtests included, was skipped ("skip is not pass",
  docs/standards/testing/testing-strategy.md), or
- fewer top-level tests ran than THRESHOLD. A test ran when it ended in pass
  or fail; the failure itself is the verdict of `go test`, not of this check.

Only top-level tests count: `go test -list` shows the same number without a
database, and a new row in a `t.Run` table does not move the threshold. The
threshold lives in the justfile and is raised by hand with the suite; one
derived from the current run would compare the suite with itself.

The events are parsed, not grepped: test2json frames every line of output,
so parallel tests and output without a trailing newline cannot hide or merge
a verdict. The summary keeps what a reader needs: the output of failed and
skipped tests, build errors, package verdicts and any line that is not an
event. stdlib only, so the gate needs no install step.
"""

import json
import sys

RECIPE = "identity-test-integration"
EDIT_PLACE = "IDENTITY_TEST_THRESHOLD в justfile"


def read_events(path):
    """Yield (event, None) per JSON event and (None, line) per other line."""
    with open(path, encoding="utf-8", errors="replace") as log:
        for line in log:
            text = line.rstrip("\r\n")
            if text.startswith("{"):
                try:
                    event = json.loads(text)
                except json.JSONDecodeError:
                    event = None
                if isinstance(event, dict) and "Action" in event:
                    yield event, None
                    continue
            if text:
                yield None, text


def judge(path, threshold, out):
    """Print the summary to `out` and return the exit code of the check."""
    outputs = {}
    order = []
    verdicts = {}
    summary = []

    for event, raw in read_events(path):
        if raw is not None:
            summary.append(("raw", raw))
            continue
        action = event["Action"]
        package = event.get("Package", "")
        test = event.get("Test")
        if action == "build-output":
            summary.append(("raw", event.get("Output", "").rstrip("\n")))
            continue
        if test is None:
            # Package level: keep its verdict lines, drop the bare PASS and
            # the RUN/PAUSE/CONT framing of a verbose run.
            if action == "output":
                text = event.get("Output", "").rstrip("\n")
                if text and text != "PASS" and not text.startswith("=== "):
                    summary.append(("raw", text))
            continue
        key = (package, test)
        if key not in outputs:
            outputs[key] = []
            order.append(key)
        if action == "output":
            outputs[key].append(event.get("Output", ""))
        elif action in ("pass", "fail", "skip"):
            verdicts[key] = action
            if action != "pass":
                summary.append(("test", key))

    for kind, value in summary:
        if kind == "raw":
            print(value, file=out)
            continue
        for text in outputs[value]:
            if not text.startswith("=== "):
                out.write(text if text.endswith("\n") else text + "\n")

    ran = sum(
        1
        for (_, test), verdict in verdicts.items()
        if "/" not in test and verdict in ("pass", "fail")
    )
    skipped = sum(1 for verdict in verdicts.values() if verdict == "skip")

    print(
        f"{RECIPE}: выполнено тестов верхнего уровня: {ran}, порог {threshold} ({EDIT_PLACE})",
        file=out,
    )
    # The verdict follows the summary it explains: stdout is buffered when
    # redirected, and an unflushed summary would land below the stderr lines.
    out.flush()
    code = 0
    if skipped > 0:
        print(
            f"{RECIPE}: пропущено тестов: {skipped} — пропуск не равен прохождению, прогон считается упавшим",
            file=sys.stderr,
        )
        code = 1
    if ran < threshold:
        print(
            f"{RECIPE}: выполнено тестов {ran}, меньше порога {threshold} — файл потерял тег "
            f"//go:build integration, пакет не собрался, паника оборвала пакет, флаг вроде -run "
            f"сузил набор или тест удалён; если набор уменьшен намеренно, поправь {EDIT_PLACE} "
            f"тем же изменением",
            file=sys.stderr,
        )
        code = 1
    return code


def main(argv):
    # A threshold of 0 would pass an empty log: no run at all reads as green.
    if len(argv) != 3 or not argv[2].isdigit() or int(argv[2]) < 1:
        print("usage: check-test-log.py LOG THRESHOLD (a whole number, at least 1)", file=sys.stderr)
        return 2
    # A Windows console defaults to a legacy code page; the messages are Russian.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    return judge(argv[1], int(argv[2]), sys.stdout)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
