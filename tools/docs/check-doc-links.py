"""Verify relative Markdown links inside docs/ resolve to a file and a heading.

A renamed heading breaks every link that points at its anchor, and the break
happens in a document the author did not touch. Review found such links twice
(PER-147, PER-142), and each time the check was rewritten as a throwaway
script with nowhere to live. This is that script, kept.

Scope: every docs/**/*.md is a source. For each inline link `](target)` the
gate asks two questions that need no judgment:

- `path.md` and `path.md#anchor` - the file exists;
- `path.md#anchor` and `#anchor` - the file has a heading whose GitHub slug is
  the anchor.

Targets may sit outside docs/ (`../../AGENTS.md`); only sources are limited to
docs/. Links with a scheme (`https:`, `mailto:`) are skipped, so a full URL to
someone else's README.md is never checked. Targets that are not `.md` - scripts,
directories, HTML pages - are out of scope. Links inside fenced blocks and
inline code are examples, not links, and are skipped too.

The file set is the working tree minus what .gitignore hides, the same set
check-document-numbers.sh reads: the gate runs before the commit, so a new
document is untracked at the moment it matters. A target that exists only as
an ignored file does not count - it will not exist on GitHub either.

Python rather than sh + awk: the slug lowercases Cyrillic, and byte-oriented
awk does that only under a UTF-8 locale, which Git Bash and the CI runner do
not share. stdlib only, so the gate needs no install step.
"""

import html
import posixpath
import re
import subprocess
import sys
import unicodedata
from urllib.parse import unquote

DOCS = "docs/"

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
HTML_COMMENT = re.compile(r"<!--.*?-->")
ATX = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$")
SETEXT = re.compile(r"^ {0,3}(=+|-+)[ \t]*$")
HTML_ANCHOR = re.compile(r"<a\s[^>]*\b(?:id|name)=[\"']([^\"']+)[\"']", re.IGNORECASE)
CODE_SPAN = re.compile(r"(`+)(.+?)\1")
LINK = re.compile(r"\]\(\s*(<[^>]*>|[^\s)]*)(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)")
INLINE_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
HTML_TAG = re.compile(r"<[^>]+>")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def slug(heading):
    """GitHub heading slug: rendered text, lowercased, punctuation dropped.

    Letters (any script), marks, digits and connector punctuation (`_`) stay,
    `-` stays, every space becomes `-` without collapsing, so `a — b` gives
    `a--b`. Everything else, emoji included, is dropped.
    """
    text = CODE_SPAN.sub(lambda m: m.group(2).strip(), heading)
    text = INLINE_LINK.sub(r"\1", text)
    text = HTML_TAG.sub("", text)
    text = html.unescape(text)
    text = unicodedata.normalize("NFC", text).lower()
    kept = []
    for ch in text:
        if ch == " ":
            kept.append("-")
        elif ch == "-" or unicodedata.category(ch)[0] in "LMN" or unicodedata.category(ch) == "Pc":
            kept.append(ch)
    return "".join(kept)


def read_lines(path):
    # utf-8-sig: a BOM left in place would hide the first heading of the file.
    with open(path, encoding="utf-8-sig", newline="") as handle:
        lines = handle.read().replace("\r\n", "\n").split("\n")
    # YAML frontmatter renders as a table on GitHub, not as a setext heading.
    # Blanked rather than dropped, so line numbers stay true.
    if lines and lines[0].strip() == "---":
        for end in range(1, len(lines)):
            if lines[end].strip() in ("---", "..."):
                return [""] * (end + 1) + lines[end + 1:]
    return lines


def outside_fences(lines):
    """Yield (number, line) for lines outside fenced code blocks.

    A fence line is yielded blank, so the paragraph before a block never reads
    as the text of a setext heading after it. Only a bare fence closes a block:
    one with an info string is content (CommonMark). HTML comments are dropped.
    """
    fence = None
    for number, line in enumerate(lines, 1):
        match = FENCE.match(line)
        if fence is None:
            if match and not (match.group(1)[0] == "`" and "`" in match.group(2)):
                fence = match.group(1)
                yield number, ""
                continue
            yield number, HTML_COMMENT.sub("", line)
        elif (
            match
            and match.group(1)[0] == fence[0]
            and len(match.group(1)) >= len(fence)
            and not match.group(2).strip()
        ):
            fence = None
            yield number, ""


def anchors_of(lines):
    """Every anchor a file offers: heading slugs with GitHub's -1, -2 suffixes, plus <a id>."""
    slugs = set()
    anchors = set()
    paragraph = []

    def add(text):
        # github-slugger registers suffixed slugs too, so the headings
        # "a", "a", "a 1" give a, a-1 and a-1-1.
        base = slug(text)
        candidate, count = base, 0
        while candidate in slugs:
            count += 1
            candidate = f"{base}-{count}"
        slugs.add(candidate)
        anchors.add(candidate)

    for _, line in outside_fences(lines):
        atx = ATX.match(line)
        if atx:
            add(atx.group(2) or "")
            paragraph = []
            continue
        if SETEXT.match(line) and paragraph and not re.match(r"^\s*([-*+>|]|\d+[.)])", paragraph[0]):
            add(" ".join(part.strip() for part in paragraph))
            paragraph = []
            continue
        for match in HTML_ANCHOR.finditer(line):
            anchors.add(unicodedata.normalize("NFC", match.group(1)).lower())
        paragraph = paragraph + [line] if line.strip() else []
    return anchors


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")

    root = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True
    ).stdout.strip()
    listed = subprocess.run(
        ["git", "-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        check=True, capture_output=True, cwd=root,
    ).stdout.decode("utf-8")

    present = set()
    for path in filter(None, listed.split("\0")):
        full = posixpath.join(root, path)
        try:
            open(full, "rb").close()
        except OSError:
            continue
        present.add(path)

    sources = sorted(p for p in present if p.startswith(DOCS) and p.endswith(".md"))
    if not sources:
        print(f"No Markdown files under {DOCS}: nothing to check.", file=sys.stderr)
        return 1

    cache = {}

    def anchors(path):
        if path not in cache:
            cache[path] = anchors_of(read_lines(posixpath.join(root, path)))
        return cache[path]

    broken = []
    checked = 0
    for source in sources:
        for number, line in outside_fences(read_lines(posixpath.join(root, source))):
            for match in LINK.finditer(CODE_SPAN.sub("", line)):
                target = match.group(1).strip("<>")
                if not target or SCHEME.match(target):
                    continue
                path, _, anchor = target.partition("#")
                path = unquote(path)
                if path and not path.endswith(".md"):
                    continue
                checked += 1
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), path)) if path else source
                where = f"{source}:{number}: {target}"
                if resolved not in present:
                    broken.append(f"  - {where} - file {resolved} does not exist")
                    continue
                if not anchor:
                    continue
                wanted = unicodedata.normalize("NFC", unquote(anchor)).lower()
                if wanted not in anchors(resolved):
                    broken.append(f"  - {where} - no heading with anchor #{wanted} in {resolved}")

    # Sources exist but no link was recognised: a broken parser and a clean
    # tree would otherwise print the same success.
    if checked == 0:
        print(f"No relative links found under {DOCS}: the link parser matched nothing.", file=sys.stderr)
        return 1

    if broken:
        print(f"Broken links under {DOCS}:", file=sys.stderr)
        print("\n".join(broken), file=sys.stderr)
        return 1

    print(f"Doc links resolve: {checked} relative links in {len(sources)} files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
