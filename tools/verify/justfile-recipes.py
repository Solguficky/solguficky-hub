"""Names the recipes a change of the justfile can affect.

Usage: python3 tools/verify/justfile-recipes.py BEFORE AFTER

BEFORE and AFTER are the justfile at the merge base and now. Prints one line:

  *            the change can affect any recipe: select everything
  NAME NAME…   the recipes whose own lines changed, the recipes that read a
               changed variable, and every recipe that depends on those,
               directly or through other recipes
  (empty)      only comments and blank lines changed

A changed line is placed in the file it belongs to: an added or edited line
in AFTER, a removed or edited line in BEFORE. Comments and blank lines outside
a recipe body are documentation: `just --list` prints them, no recipe runs
them. A comment inside a body is a line of the recipe and counts.

Anything this script does not recognise at the top level — `set`, `import`,
`mod`, `alias`, a line it cannot place — selects everything, as do changes of
`verify` and `verify-changed` themselves: the first is the list the selection
is checked against, the second runs it. Selecting too much costs a slow gate;
selecting too little lets a change skip its own checks.

tools/verify/select-recipes.sh calls it when `justfile` is among the changed
paths; the cases are in select-recipes-test.sh.
"""

import difflib
import re
import sys

EVERYTHING = "*"
SELECTS_EVERYTHING = {"verify", "verify-changed"}

VARIABLE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*:=")
ATTRIBUTE = re.compile(r"^\[")
RECIPE = re.compile(r"^@?([A-Za-z_][A-Za-z0-9_-]*)\b([^:]*):(?!=)(.*)$")
NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")


class Justfile:
    def __init__(self, text):
        self.lines = [line.rstrip("\r") for line in text.split("\n")]
        # Owner of each line: ("recipe", name), ("variable", name),
        # ("doc", None) or ("unknown", None).
        self.owner = []
        self.recipe_text = {}
        self.variable_text = {}
        self.deps = {}
        pending = []  # attribute lines waiting for their recipe
        current = None
        for line in self.lines:
            indented = line[:1] in (" ", "\t")
            if line.strip() == "":
                self.owner.append(("doc", None))
                continue
            if indented and current is not None:
                self.owner.append(("recipe", current))
                self.recipe_text[current] += "\n" + line
                continue
            current = None
            if line.startswith("#"):
                self.owner.append(("doc", None))
                continue
            match = VARIABLE.match(line)
            if match:
                self.owner.append(("variable", match.group(1)))
                self.variable_text[match.group(1)] = line[match.end():]
                continue
            if ATTRIBUTE.match(line):
                self.owner.append(("attribute", None))
                pending.append(len(self.owner) - 1)
                continue
            match = RECIPE.match(line)
            if match and not indented:
                current = match.group(1)
                self.owner.append(("recipe", current))
                for index in pending:
                    self.owner[index] = ("recipe", current)
                pending = []
                self.recipe_text[current] = line
                self.deps[current] = set(NAME.findall(match.group(3)))
                continue
            self.owner.append(("unknown", None))
        for index in pending:
            self.owner[index] = ("unknown", None)


def affected(before, after):
    old, new = Justfile(before), Justfile(after)
    recipes, variables = set(), set()

    def place(owner):
        kind, name = owner
        if kind == "recipe":
            recipes.add(name)
        elif kind == "variable":
            variables.add(name)
        elif kind != "doc":
            return False
        return True

    matcher = difflib.SequenceMatcher(None, old.lines, new.lines, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        for i in range(i1, i2):
            if not place(old.owner[i]):
                return EVERYTHING
        for j in range(j1, j2):
            if not place(new.owner[j]):
                return EVERYTHING

    # A variable read by another variable changes that one too.
    texts = dict(old.variable_text)
    texts.update(new.variable_text)
    frontier = set(variables)
    while frontier:
        name = frontier.pop()
        pattern = re.compile(r"(?<![A-Za-z0-9_-])" + re.escape(name) + r"(?![A-Za-z0-9_-])")
        for other, text in texts.items():
            if other not in variables and pattern.search(text):
                variables.add(other)
                frontier.add(other)
        for parsed in (old, new):
            for recipe, text in parsed.recipe_text.items():
                if pattern.search(text):
                    recipes.add(recipe)

    if recipes & SELECTS_EVERYTHING:
        return EVERYTHING

    # Every recipe that runs a changed recipe as a dependency.
    deps = {}
    for parsed in (old, new):
        for recipe, names in parsed.deps.items():
            deps.setdefault(recipe, set()).update(names)
    closure = set(recipes)
    grew = True
    while grew:
        grew = False
        for recipe, names in deps.items():
            if recipe not in closure and names & closure:
                closure.add(recipe)
                grew = True
    closure -= SELECTS_EVERYTHING
    return " ".join(sorted(closure))


def main(argv):
    if len(argv) != 3:
        print("usage: justfile-recipes.py BEFORE AFTER", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as handle:
        before = handle.read()
    with open(argv[2], encoding="utf-8") as handle:
        after = handle.read()
    print(affected(before, after))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
