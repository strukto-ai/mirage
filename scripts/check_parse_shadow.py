import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from collections import Counter
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import tree_sitter
import tree_sitter_bash

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "python"))

from mirage._rs import ShellTree  # noqa: E402

INTEG = REPO / "integ"
FIXTURE = INTEG / "fixtures" / "shell" / "parse_shadow.json"
SYNTAX = INTEG / "fixtures" / "shell" / "bash_syntax.json"
IMAGE = "debian:stable-slim"
PINNED = (
    "bash 5.2.37 (debian:stable-slim): `bash -n -c LINE` per line; per"
    " example, `declare -f f` after `f() { LINE }` and the output of"
    " `bash -c LINE`"
)
GRAMMAR = tree_sitter.Parser(tree_sitter.Language(tree_sitter_bash.language()))

# Every line's status, then per example how bash prints it back and what
# it prints when it runs. `-n` reads without running anything, a function
# body is only defined, and an example runs in a scratch directory of a
# container thrown away after. A line starting with a dash gets a blank in
# front, so bash reads it as a command rather than an option.
LOOP = r"""
while IFS= read -r -d '' line; do
  case "$line" in -*|+*) line=" $line" ;; esac
  timeout 5 bash -n -c "$line" >/dev/null 2>&1 </dev/null; printf '%s\0' "$?"
done < /pin/lines.bin > /pin/status.bin
mkdir -p /tmp/run && cd /tmp/run
while IFS= read -r -d '' line; do
  out=$(timeout 5 bash -c "f() {
$line
}
declare -f f" 2>/dev/null </dev/null); printf '%s\0' "$out"
  out=$(timeout 5 bash -c "$line" 2>&1 </dev/null); printf '%s\0' "$out"
done < /pin/examples.bin > /pin/rendered.bin
"""

Tree = list[Any]
Rule = Callable[[bytes, Tree, Tree], bool]


def nodes(tree: Tree) -> Iterator[Tree]:
    stack = [tree]
    while stack:
        node = stack.pop()
        yield node
        stack.extend(reversed(node[8]))


def text(data: bytes, node: Tree) -> bytes:
    return data[node[3] : node[4]]


def fd_zero(data: bytes, ts: Tree, rs: Tree) -> bool:
    zeros = {
        n[4] for n in nodes(ts) if n[0] == "number" and text(data, n) == b"0"
    }
    return any(
        n[0] == "file_redirect"
        and n[3] in zeros
        and not any(c[2] == "descriptor" for c in n[8])
        for n in nodes(ts)
    )


NAME = frozenset(
    b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789"
)


def orphaned_dollar(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(
        c[0] == "$"
        and not c[1]
        and n[0] not in ("simple_expansion", "string")
        and data[c[4] : c[4] + 1]
        and data[c[4]] in NAME
        for n in nodes(ts)
        for c in n[8]
    )


def positional_digit(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(
        n[0] == "simple_expansion"
        and len(text(data, n)) > 2
        and text(data, n)[1:2].isdigit()
        for n in nodes(ts)
    )


def time_word(data: bytes, ts: Tree, rs: Tree) -> bool:
    """A `time` timing a pipeline, where the trees agree once its keywords
    are blanked: a `:` stands in for one that times nothing."""
    blanked = bytearray(data)
    found = False
    for n in nodes(rs):
        if n[0] != "timed_statement":
            continue
        found = True
        for word in n[8]:
            if not word[1]:
                blanked[word[3] : word[4]] = b" " * (word[4] - word[3])
        if all(not c[1] for c in n[8]):
            blanked[n[3] : n[3] + 1] = b":"
    if not found:
        return False
    ts, ts_error, rs, rs_error = trees(
        blanked.decode("utf-8", "surrogateescape")
    )
    return not ts_error and not rs_error and first_difference(ts, rs) is None


def heredoc_body(data: bytes, ts: Tree, rs: Tree) -> bool:
    if b"<<" not in data.replace(b"<<<", b""):
        return False
    for n in nodes(ts):
        if n[0] == "heredoc_redirect" and any(
            c[2] == "argument" and data[c[3] : c[3] + 1] in (b"\n", b"\\")
            for c in n[8]
        ):
            return True
        if n[0] == "heredoc_start":
            word = text(data, n)
            if word[:1] == b"$" or any(byte in word for byte in b";|&<>()"):
                return True
        if n[0] == "heredoc_end":
            after = data[n[4] : n[4] + 1]
            line = data[data.rfind(b"\n", 0, n[3]) + 1 : n[3]]
            if (
                after not in (b"", b"\n")
                or line.strip(b"\t")
                or (line and b"<<-" not in data)
            ):
                return True
    for n in nodes(rs):
        if n[0] == "heredoc_body" and text(data, n)[:1] == b"\\":
            return True
        if n[0] == "heredoc_body" and any(
            c[0] == "arithmetic_expansion" for c in n[8]
        ):
            return True
        if n[0] == "heredoc_content" and text(data, n)[:2] in (b"$(", b"${"):
            return True
        if n[0] == "heredoc_body" and any(
            c[0] != "heredoc_content" for c in n[8]
        ):
            if any(
                m[0] == "heredoc_body" and m[3] == n[3] and not m[8]
                for m in nodes(ts)
            ):
                return True
    return False


def translated_string(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(n[0] == "translated_string" for n in nodes(rs))


def backtick_pairing(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(
        n[0] == "command_substitution"
        and text(data, n)[:1] == b"`"
        and text(data, n).count(b"`") > 2
        for n in nodes(ts)
    )


def regex_argument(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(
        n[0] == "command"
        and any(c[0] == "regex" and c[2] == "argument" for c in n[8])
        for n in nodes(ts)
    )


def shape(tree: Tree) -> Tree:
    """A tree without its spans: kind, named, field, missing, children.

    Args:
        tree (Tree): a canonical tree.
    """
    return [*tree[:3], tree[7], [shape(child) for child in tree[8]]]


def regex_ampersand(data: bytes, ts: Tree, rs: Tree) -> bool:
    """A regex the grammar takes whole across an `&&`, where bash ends it:
    the parser's tree is the one both give once the `&&` is spaced out."""
    splits = []
    for n in nodes(ts):
        if n[0] != "regex":
            continue
        depth = 0
        for at in range(n[3], n[4]):
            depth += (data[at] == ord("(")) - (data[at] == ord(")"))
            if depth == 0 and data[at : at + 2] == b"&&":
                splits.append(at)
                break
    if not splits:
        return False
    spaced = data
    for at in sorted(splits, reverse=True):
        spaced = spaced[:at] + b" && " + spaced[at + 2 :]
    ts, ts_error, spaced_rs, rs_error = trees(
        spaced.decode("utf-8", "surrogateescape")
    )
    return (
        not ts_error
        and not rs_error
        and first_difference(ts, spaced_rs) is None
        and shape(rs) == shape(spaced_rs)
    )


def negated_compound(data: bytes, ts: Tree, rs: Tree) -> bool:
    simple = ("command", "test_command", "subshell", "variable_assignment")
    return any(
        n[0] == "negated_command" and n[8] and n[8][-1][0] not in simple
        for n in nodes(rs)
    )


def gaps(data: bytes, ts: Tree) -> Iterator[bytes]:
    for n in nodes(ts):
        for a, b in zip(n[8], n[8][1:]):
            yield data[a[4] : b[3]]


def dropped_dash(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(gap.strip() == b"-" for gap in gaps(data, ts))


def escaped_blank(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(b"\\ " in gap or b"\\\t" in gap for gap in gaps(data, ts))


def swallowed_newline(data: bytes, ts: Tree, rs: Tree) -> bool:
    joins = {
        "|",
        "|&",
        "&&",
        "||",
        ";",
        "&",
        "!",
        "(",
        "{",
        "then",
        "do",
        "else",
        "in",
    }
    kinds = {
        "command",
        "file_redirect",
        "pipeline",
        "redirected_statement",
        "variable_assignment",
        "concatenation",
        "negated_command",
        "herestring_redirect",
        "declaration_command",
    }
    for n in nodes(ts):
        if n[0] not in kinds:
            continue
        kids = [c for c in n[8] if c[0] != "comment"]
        for a, b in zip(kids, kids[1:]):
            if a[0] not in joins and b"\n" in data[a[4] : b[3]].replace(
                b"\\\n", b""
            ):
                return True
    return False


def continuation(data: bytes, ts: Tree, rs: Tree) -> bool:
    return b"\\\n" in data and any(
        not n[8] and b"\\\n" in text(data, n) for n in nodes(rs)
    )


def special_in_value(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(
        n[0] == "expansion"
        and any(c[0] == "word" and text(data, c)[:1] == b"$" for c in n[8])
        for n in nodes(ts)
    )


def assignment_name(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(
        n[0] == "variable_assignment" and text(data, n[8][0])[:1].isdigit()
        for n in nodes(ts)
    ) or any(
        n[0] == "variable_assignment" and text(data, n[8][0]) == b"_"
        for n in nodes(rs)
    )


def coproc(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(
        n[0] == "command" and text(data, n)[:6] == b"coproc" for n in nodes(rs)
    )


RESERVED = frozenset(
    {b"if", b"then", b"else", b"elif", b"fi", b"do", b"done", b"case", b"esac"}
    | {
        b"while",
        b"until",
        b"for",
        b"in",
        b"select",
        b"function",
        b"time",
        b"coproc",
    }
)


def reserved_prefix(data: bytes, ts: Tree, rs: Tree) -> bool:
    return any(
        n[0] == "command_name" and text(data, n) in RESERVED for n in nodes(ts)
    ) and any(
        n[0] == "command_name" and text(data, n) not in RESERVED
        for n in nodes(rs)
    )


# Where tree-sitter-bash 0.25.1 misreads bash, the parser builds bash's
# reading instead. Each reason names one misreading, says what bash does,
# and holds an example the fixture pins with bash's own rendering.
REASONS: dict[str, tuple[str, str, Rule]] = {
    "fd-zero": (
        "The grammar's scanner never reads a descriptor that starts with 0:"
        " `exec 0>f` is an argument `0` and `> f`. bash redirects fd 0.",
        "printf x > f; exec 0<f; read v; echo $v",
        fd_zero,
    ),
    "orphaned-dollar": (
        "A later unbraced expansion followed by a byte no name holds loses"
        " its name: `$a/$b.c` is `$a/$` and a word `b.c`.",
        "a=x b=y; echo $a/$b.c",
        orphaned_dollar,
    ),
    "positional-digit": (
        "`$10` and `$1a` read as one name; bash takes one digit.",
        "set -- a; echo $10 $1a",
        positional_digit,
    ),
    "time-word": (
        "`time` is a reserved word timing the pipeline after it, redirects"
        " included; the grammar reads a command named time.",
        "TIMEFORMAT=T; time echo a | tr a b > /dev/null",
        time_word,
    ),
    "heredoc-body": (
        "The grammar's heredoc scanner: a body line led by a backslash is"
        " read as the next word of the operator line, the delimiter word"
        " runs to a blank (`<<EOF;`), a line that only starts with the"
        " delimiter or is indented ends a `<<` body, `$((` reads as a"
        " command substitution, a `$`-led or indented body expansion stays"
        " text, a body substitution is parsed though bash parses it only"
        " when it expands it, and two heredocs on a line fail.",
        "cat <<EOF; cat <<'E'\n\\x $((1+1))\nEOF\ny\nE",
        heredoc_body,
    ),
    "translated-string": (
        '`$"x"` reads as an argument `$` and a string; bash reads one'
        " translated string.",
        'echo $"x"',
        translated_string,
    ),
    "backtick-pairing": (
        "Two backtick substitutions in a word list read as one.",
        "echo `echo a` `echo b`",
        backtick_pairing,
    ),
    "regex-argument": (
        "After a `==` or `=~` argument, the words up to a closing bracket"
        " read as one regex.",
        "x=1; (echo == $x)",
        regex_argument,
    ),
    "regex-ampersand": (
        "A regex after `=~` takes an `&` outside parentheses; bash ends the"
        " regex there and reads `&&` as the and operator.",
        "[[ ab =~ b&&a ]]; echo $?",
        regex_ampersand,
    ),
    "negated-compound": (
        "`!` takes only a simple command, a test or a subshell; bash negates"
        " any pipeline.",
        "! { false; }; echo $?",
        negated_compound,
    ),
    "dropped-dash": (
        "A lone `-` before a descriptor redirect is dropped.",
        "echo a - 2>&1",
        dropped_dash,
    ),
    "escaped-blank": (
        "A word that starts with a backslash and a blank skips the pair as"
        " a blank; bash keeps an escaped blank.",
        "printf '[%s]' \\ a",
        escaped_blank,
    ),
    "swallowed-newline": (
        "A newline after a prefix redirect or a pipeline's last word is"
        " skipped, joining the next line's command; bash ends the command.",
        "a=1 >/dev/null\nb=2 >/dev/null\necho $a$b",
        swallowed_newline,
    ),
    "continuation": (
        "A line continuation inside a word splits it; bash joins the halves.",
        "ec\\\nho a",
        continuation,
    ),
    "special-in-value": (
        "`${u:-$*}` reads `$*` as a word; bash expands it.",
        "set -- p q; echo ${u:-$*}",
        special_in_value,
    ),
    "assignment-name": (
        "A name led by a digit reads as an assignment and `_=` never does;"
        " bash runs `1a=x` as a command and assigns `_`.",
        "1a=x; echo $?",
        assignment_name,
    ),
    "coproc": (
        "`coproc` is a reserved word taking a compound command; the grammar"
        " reads a command named coproc.",
        "coproc NAME { echo hi; }; read -u ${NAME[0]} v; echo $v",
        coproc,
    ),
    "reserved-prefix": (
        "A word that only starts with a reserved word reads as the reserved"
        " word.",
        "done`a`elif",
        reserved_prefix,
    ),
}


def canon(node: Any, field: str | None = None) -> Tree:
    """A tree as nested lists: kind, named, field, byte span, point span,
    missing, children. Works over either parser's nodes.

    Args:
        node (Any): a tree-sitter or mirage node.
        field (str | None): its field in its parent.
    """
    children = node.children
    return [
        node.type,
        bool(node.is_named),
        field,
        node.start_byte,
        node.end_byte,
        tuple(node.start_point),
        tuple(node.end_point),
        bool(node.is_missing),
        [
            canon(child, node.field_name_for_child(i))
            for i, child in enumerate(children)
        ],
    ]


def walk(value: Any, key: str | None, found: dict[str, None]) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            walk(v, k, found)
    elif isinstance(value, list):
        for v in value:
            walk(v, key, found)
    elif isinstance(value, str) and key == "command":
        found.setdefault(value, None)


def corpus() -> list[str]:
    """Every shell line of the integ corpus: each case's `command` and each
    line of the bash syntax fixture."""
    found: dict[str, None] = {}
    for path in sorted(INTEG.rglob("*.json")):
        skipped = "node_modules" in path.parts or "generated" in path.parts
        # A TypeScript config is JSON with comments, and holds no case.
        if skipped or path.name.startswith("tsconfig"):
            continue
        walk(json.loads(path.read_text()), None, found)
    for row in json.loads(SYNTAX.read_text())["lines"]:
        found.setdefault(row["line"], None)
    return list(found)


def encoded(line: str) -> bytes:
    return line.encode("utf-8", "surrogateescape")


def key(line: str) -> str:
    return hashlib.sha1(encoded(line)).hexdigest()[:16]


def digest(lines: list[str]) -> str:
    """The corpus a pin covered: every line has bash's status from it.

    Args:
        lines (list[str]): the corpus.
    """
    keys = "\n".join(sorted(key(line) for line in lines))
    return hashlib.sha1(keys.encode()).hexdigest()[:16]


def trees(line: str) -> tuple[Tree, bool, Tree, bool]:
    data = encoded(line)
    ts = GRAMMAR.parse(data).root_node
    rs = ShellTree(data).root_node
    return canon(ts), ts.has_error, canon(rs), rs.has_error


def first_difference(a: Tree, b: Tree) -> str | None:
    if a[:8] != b[:8]:
        return f"{a[:8]} vs {b[:8]}"
    for x, y in zip(a[8], b[8]):
        found = first_difference(x, y)
        if found:
            return found
    if len(a[8]) != len(b[8]):
        return f"{a[0]}: {len(a[8])} vs {len(b[8])} children"
    return None


def reason(line: str, ts: Tree, rs: Tree) -> str | None:
    data = encoded(line)
    for name, (_, _, rule) in REASONS.items():
        if rule(data, ts, rs):
            return name
    return None


def classify(line: str, status: dict[str, int]) -> tuple[str, str]:
    """Why the two parses of a line agree or differ.

    Args:
        line (str): the line.
        status (dict[str, int]): bash's pinned `-n` status by line key.

    Returns:
        tuple[str, str]: the verdict, and what went wrong for a failure.
    """
    ts, ts_error, rs, rs_error = trees(line)
    if not ts_error and not rs_error:
        if status.get(key(line), 0) != 0:
            return "unexplained", f"bash status {status[key(line)]}"
        difference = first_difference(ts, rs)
        if difference is None:
            return "same", ""
        found = reason(line, ts, rs)
        return (found, "") if found else ("unexplained", difference)
    bash = status.get(key(line))
    if bash is None:
        return "unpinned", "no pinned bash status; run with --pin"
    if rs_error != (bash != 0):
        return "unexplained", f"parser error={rs_error}, bash status {bash}"
    if rs_error:
        return "both-refuse", ""
    return "grammar-refuses", ""


def pin(
    lines: list[str], examples: list[str]
) -> tuple[list[int], list[tuple[int, str, str]]]:
    """bash's `-n` status for each line, and each example's status,
    rendering and output, from docker.

    Args:
        lines (list[str]): the lines to pin.
        examples (list[str]): the examples to render.
    """
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "lines.bin").write_bytes(
            b"".join(encoded(line) + b"\0" for line in lines + examples)
        )
        (work / "examples.bin").write_bytes(
            b"".join(encoded(line) + b"\0" for line in examples)
        )
        (work / "loop.sh").write_text(LOOP)
        subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "-v",
                f"{work}:/pin",
                IMAGE,
                "bash",
                "/pin/loop.sh",
            ],
            check=True,
        )
        status = [
            int(s)
            for s in (work / "status.bin").read_bytes().split(b"\0")[:-1]
        ]
        rendered = [
            r.decode("utf-8", "replace")
            for r in (work / "rendered.bin").read_bytes().split(b"\0")[:-1]
        ]
    examples_status = status[len(lines) :]
    return status[: len(lines)], [
        (got, rendered[2 * i], rendered[2 * i + 1])
        for i, got in enumerate(examples_status)
    ]


def dumped(fixture: dict[str, Any]) -> str:
    """The fixture's text, one row per line so a re-pin diffs by line.
    Every line of the corpus is pinned; the statuses kept are those of the
    lines either parser or bash refuses.

    Args:
        fixture (dict[str, Any]): the pin note, corpus digest, examples and
            statuses.
    """
    examples = ",\n".join(
        f"  {json.dumps(name)}: {json.dumps(row, ensure_ascii=False)}"
        for name, row in sorted(fixture["examples"].items())
    )
    status = ",\n".join(
        f"  {json.dumps(k)}: {v}" for k, v in sorted(fixture["status"].items())
    )
    pinned = json.dumps(fixture["pinned"])
    corpus = json.dumps(fixture["corpus"])
    return (
        f'{{\n "pinned": {pinned},\n "corpus": {corpus},\n'
        f' "examples": {{\n{examples}\n }},\n "status": {{\n{status}\n }}\n}}\n'
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Parse every shell line of the integ corpus with tree-sitter-bash"
            " and with mirage's own parser, and check that their trees match"
            " except where a named misreading of the grammar's explains it,"
            " and that the parser refuses exactly what bash refuses."
        )
    )
    parser.add_argument(
        "--pin",
        action="store_true",
        help="pin bash's verdicts in docker and rewrite the fixture",
    )
    args = parser.parse_args()
    lines = corpus()
    fixture: dict[str, Any] = (
        json.loads(FIXTURE.read_text())
        if FIXTURE.exists()
        else {"pinned": PINNED, "examples": {}, "status": {}}
    )
    if args.pin:
        examples = [example for _, example, _ in REASONS.values()]
        status, rendered = pin(lines, examples)
        kept = {}
        for line, got in zip(lines, status):
            _, ts_error, _, rs_error = trees(line)
            if ts_error or rs_error or got != 0:
                kept[key(line)] = got
        fixture = {
            "pinned": PINNED,
            "corpus": digest(lines),
            "examples": {
                name: {
                    "line": example,
                    "status": got,
                    "declared": text,
                    "output": out,
                }
                for (name, (_, example, _)), (got, text, out) in zip(
                    REASONS.items(), rendered
                )
            },
            "status": kept,
        }
        FIXTURE.write_text(dumped(fixture))
    failures = []
    if fixture.get("corpus") != digest(lines):
        failures.append("the corpus changed since the pin; run with --pin")
    for name, (_, example, rule) in REASONS.items():
        ts, ts_error, rs, _ = trees(example)
        row = fixture["examples"].get(name)
        if row is None or row["line"] != example:
            failures.append(f"example {name!r} is not pinned; run with --pin")
        elif row["status"] != 0:
            failures.append(f"example {name!r}: bash refuses {example!r}")
        elif not rule(encoded(example), ts, rs):
            failures.append(f"example {name!r} no longer shows its misreading")
    verdicts: Counter[str] = Counter()
    for line in lines:
        verdict, why = classify(line, fixture["status"])
        verdicts[verdict] += 1
        if verdict in ("unexplained", "unpinned"):
            failures.append(f"{line!r}: {why}")
    for verdict, count in sorted(verdicts.items(), key=lambda item: -item[1]):
        print(f"{count:6d} {verdict}")
    for failure in failures[:40]:
        print(failure, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
