#!/usr/bin/env sh
# Verify docs/published/ stays a site whose folder layout is its address map.
#
# The folder is deployed as-is: `netlify deploy --prod --dir` replaces the site
# with whatever it contains. Two properties therefore have to hold before a push
# reaches develop, and neither is visible reading a diff page by page.
#
# First, the address of a page must be a property of this repository rather than
# of a dashboard. A flat `auction-2026.html` is served at /auction-2026 only
# while Netlify's Pretty URLs option is on, and that option is invisible from
# Git; `auction-2026/index.html` is served there by ordinary directory-index
# resolution, on Netlify and on any other static host. So index.html is the only
# page name allowed, and the path minus index.html is the address.
#
# Second, nothing but a page may sit here: a draft, a note or a backup file
# placed in this folder is published to the open web on the next push. Two
# narrow exceptions are part of a page rather than loose files: images inside
# the folder of a page below the root (slides of /karaoke live in
# karaoke/slides/), and `_headers` at the root, which Netlify reads as response
# headers instead of serving it.
#
# The gate reads Git, not the working tree: an untracked scratch file is the
# author's business, a committed one is the defect this check exists for. The
# deploy step copies the working tree, so a tracked page missing from it is
# reported too — otherwise the two could disagree and only the live site would
# say so.

set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

SITE='docs/published'

# Both quote styles: href='/x' resolves exactly like href="/x" in a browser, so
# a gate that only knows double quotes has a blind spot precisely where a typo
# would hide.
HREF="href=(\"[^\"]*\"|'[^']*')"

broken=$(mktemp)
trap 'rm -f "$broken"' EXIT

failed=0

# Kept separate from the filters below: piping straight into grep would hide a
# failing `git` as an empty result, and the gate would report success for
# "could not look" the same way it reports it for "nothing found".
# core.quotePath=false: by default `git ls-files` escapes non-ASCII paths as
# "Ð¿...", and a Cyrillic address would then be rejected as "not a page".
tracked=$(git -c core.quotePath=false ls-files -- "$SITE")

if [ -z "$tracked" ]; then
    echo "No tracked files under $SITE: the published site is missing." >&2
    exit 1
fi

# 1. Only the section README, Netlify's `_headers`, index.html pages and images
#    inside a page folder live here.
candidates=$(printf '%s\n' "$tracked" \
    | grep -v -x -F "$SITE/README.md" \
    | grep -v -x -F "$SITE/_headers" \
    | grep -v '/index\.html$' || true)

# An image belongs to a page when one of its ancestor folders below the root is
# a page, i.e. holds a tracked index.html. A stray image at the root or in a
# folder without a page is still a loose file.
unexpected=$(printf '%s\n' "$candidates" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    case $file in
        *.jpg | *.jpeg | *.png | *.webp)
            dir=${file%/*}
            owned=0
            while [ "$dir" != "$SITE" ] && [ "${dir#"$SITE"/}" != "$dir" ]; do
                if printf '%s\n' "$tracked" | grep -q -x -F "$dir/index.html"; then
                    owned=1
                    break
                fi
                dir=${dir%/*}
            done
            [ "$owned" -eq 1 ] && continue
            ;;
    esac
    printf '%s\n' "$file"
done)

if [ -n "$unexpected" ]; then
    echo "Files in $SITE that are neither the section README, _headers, a page nor an image of a page:" >&2
    printf '%s\n' "$unexpected" | sed 's/^/  - /' >&2
    echo "A page is always <folder>/index.html; the path minus index.html is its address." >&2
    echo "Images (jpg, jpeg, png, webp) go inside the folder of the page that shows them." >&2
    echo "Anything else here goes public on the next push to develop." >&2
    failed=1
fi

# 2. The site root exists — asked of Git, like every other check here, so that a
#    root present in the working tree but absent from the commit still fails.
if ! printf '%s\n' "$tracked" | grep -q -x -F "$SITE/index.html"; then
    echo "$SITE/index.html is not tracked: the root of the site would answer 404." >&2
    failed=1
fi

pages=$(printf '%s\n' "$tracked" | grep '/index\.html$' || true)
page_count=$(printf '%s\n' "$pages" | grep -c . || true)

# 3. Every root-relative link resolves to a page that exists.
#
# This is the one check that ties the index to the layout. The index links to
# /auction-2026 and /archive/auction-module by their site addresses, so a typo
# in a folder name cannot be caught by anything else in the repository: it would
# surface only as a dead link on the live site.
#
# Findings are collected in a file rather than a variable: `... | while read`
# runs in a subshell, and a flag set inside it would not survive the loop.
printf '%s\n' "$pages" | while IFS= read -r page; do
    [ -n "$page" ] || continue

    if [ ! -f "$page" ]; then
        echo "  - $page: tracked but missing from the working tree" >> "$broken"
        continue
    fi

    grep -n -oE "$HREF" "$page" | while IFS= read -r hit; do
        lineno=${hit%%:*}
        raw=${hit#*href=}
        value=${raw#?}
        value=${value%?}

        case $value in
            //*) continue ;;   # protocol-relative, i.e. an external host
            /*) ;;             # a site address — the case this gate is about
            *) continue ;;     # anchor, external URL or a relative path
        esac

        target=${value%%#*}
        target=${target%%\?*}
        target=${target%/}

        if [ -z "$target" ]; then
            file="$SITE/index.html"
        else
            file="$SITE$target/index.html"
        fi

        printf '%s\n' "$tracked" | grep -q -x -F "$file" \
            || echo "  - $page:$lineno -> $value (expected $file)" >> "$broken"
    done
done

if [ -s "$broken" ]; then
    echo "Links that do not resolve to a published page:" >&2
    cat "$broken" >&2
    echo "The layout of $SITE is the address map; fix the folder, not the link." >&2
    failed=1
fi

if [ "$failed" -ne 0 ]; then
    exit 1
fi

echo "Published pages are addressable: $page_count page(s) under $SITE."
