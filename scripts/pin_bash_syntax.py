import argparse
import json
import random
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "python"))

from mirage.shell.parse import check_syntax  # noqa: E402

FIXTURE = REPO / "integ" / "fixtures" / "shell" / "bash_syntax.json"
IMAGE = "debian:stable-slim"
PINNED = "bash 5.2.37 (debian:stable-slim), parse only: bash -n -c LINE"

# Read every line, NUL-separated, and print bash's status and stderr for
# it, NUL-separated too. `-n` reads without running anything, so a
# generated line can never touch the container; a line bash's reader
# never finishes is cut off at five seconds (status 124).
LOOP = r"""
while IFS= read -r -d '' line; do
  err=$(timeout 5 bash -n -c "$line" 2>&1 >/dev/null </dev/null); rc=$?
  printf '%s\0%s\0' "$rc" "$err"
done < /pin/lines.bin > /pin/results.bin
"""

# The pieces the fuzzer splices into a line, and how it cuts one.
FRAGMENTS = (
    ";",
    ";;",
    "&",
    "&&",
    "|",
    "||",
    "(",
    ")",
    "((",
    "))",
    "{",
    "}",
    "if",
    "then",
    "fi",
    "do",
    "done",
    "esac",
    "in",
    "case",
    "for",
    "while",
    '"',
    "'",
    "`",
    "$(",
    "${",
    "$((",
    "[[",
    "]]",
    "<",
    ">",
    "<<",
    "\n",
    "#",
    "x=(",
    "!",
    "time",
    "function",
    "\\",
    "=~",
    "==",
    "-f",
    "]",
    "[",
    "$",
)
TOKEN = re.compile(r"\s+|[;&|<>()]+|[^\s;&|<>()]+")
PREFIX = re.compile(r"^bash: (-c: )?line \d+: ")
# mirage words both of bash's "near" forms alike, the token in quotes.
NEAR = ("syntax error near unexpected token `", "syntax error near `")


def pin(lines: list[str]) -> list[tuple[int, str]]:
    """Run each line through bash's parser in docker.

    Args:
        lines (list[str]): the lines.

    Returns:
        list[tuple[int, str]]: per line, bash's status and the stderr mirage
        prints for it: bash's diagnostic lines in mirage's words.
    """
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "lines.bin").write_bytes(
            b"".join(line.encode() + b"\0" for line in lines)
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
        fields = (work / "results.bin").read_bytes().split(b"\0")
    results = []
    for i in range(len(lines)):
        status = int(fields[2 * i])
        err = fields[2 * i + 1].decode(errors="replace")
        results.append((status, mirage_stderr(err) if status else ""))
    return results


def mirage_stderr(err: str) -> str:
    """bash's diagnostic as mirage prints it: each line's ``bash: -c: line
    N:`` prefix becomes ``mirage:``, the token bash names near is quoted
    with ``'``, and the echo of the offending line bash prints after a
    ``syntax error near`` line is left out, as are its warnings; the
    echo and a heredoc warning's delimiter may span lines themselves.

    Args:
        err (str): bash's stderr.
    """
    out: list[str] = []
    until = ""
    for raw in err.splitlines():
        line = PREFIX.sub("", raw)
        if until:
            until = "" if line.endswith(until) else until
            continue
        if line.startswith("warning:") or raw.startswith("bash: warning:"):
            if "(wanted `" in line and not line.endswith("')"):
                until = "')"
            continue
        if (
            line.startswith("`")
            and out
            and out[-1].startswith("syntax error near")
        ):
            if not line.endswith("'") or line == "`":
                until = "'"
            continue
        out.append(line)
    return "".join(f"mirage: {worded(line)}\n" for line in out)


def worded(line: str) -> str:
    for opener in NEAR:
        if line.startswith(opener) and line.endswith("'"):
            return f"syntax error near '{line[len(opener) : -1]}'"
    return line


def dumped(corpus: dict[str, Any]) -> str:
    """The fixture's text, one line per row so a re-pin diffs by line.

    Args:
        corpus (dict[str, Any]): the pin note and the rows.
    """
    rows = ",\n".join(
        "  " + json.dumps(row, ensure_ascii=False) for row in corpus["lines"]
    )
    pinned = json.dumps(corpus["pinned"])
    return f'{{\n "pinned": {pinned},\n "lines": [\n{rows}\n ]\n}}\n'


def checked(line: str) -> tuple[int, str]:
    """mirage's status and stderr for a line.

    Args:
        line (str): the line.
    """
    found = check_syntax(line)
    return (0, "") if found is None else (found.status, found.message)


def mutations(seed: str, rng: random.Random, count: int) -> set[str]:
    """Cut and splice a line the way the fuzzer does: every prefix, every
    token dropped, and ``count`` random fragments inserted or swapped in.

    Args:
        seed (str): the line.
        rng (random.Random): the seeded generator.
        count (int): how many random edits to make.
    """
    tokens = TOKEN.findall(seed)
    bounds = [0]
    for token in tokens:
        bounds.append(bounds[-1] + len(token))
    out = {seed[:k] for k in range(1, len(seed) + 1)}
    out.update(
        "".join(tokens[:k] + tokens[k + 1 :]) for k in range(len(tokens))
    )
    for _ in range(count):
        at = rng.choice(bounds)
        out.add(seed[:at] + rng.choice(FRAGMENTS) + seed[at:])
        if tokens:
            k = rng.randrange(len(tokens))
            out.add(
                "".join(tokens[:k] + [rng.choice(FRAGMENTS)] + tokens[k + 1 :])
            )
    return {line for line in out if line.strip() and not line.startswith("-")}


def main() -> int:
    """Re-pin the corpus against bash, or fuzz the reader against bash.

    Returns:
        0 when the reader agrees with bash on every line checked, 1
        otherwise.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--fuzz",
        type=int,
        metavar="N",
        help="mutate the corpus's accepted lines N times each, pin the "
        "results and report where the reader disagrees, writing nothing",
    )
    parser.add_argument("--seed", type=int, default=1499)
    args = parser.parse_args()
    corpus = json.loads(FIXTURE.read_text())
    if args.fuzz:
        rng = random.Random(args.seed)
        lines: set[str] = set()
        for row in corpus["lines"]:
            if row["status"] == 0:
                lines.update(mutations(row["line"], rng, args.fuzz))
        lines_checked = sorted(lines)
    else:
        lines_checked = sorted({row["line"] for row in corpus["lines"]})
    pinned = pin(lines_checked)
    disagree = 0
    for line, expected in zip(lines_checked, pinned, strict=True):
        if checked(line) != expected:
            disagree += 1
            print(f"{line!r}\n  bash   {expected}\n  mirage {checked(line)}")
    print(f"{len(lines_checked) - disagree}/{len(lines_checked)} lines agree")
    if not args.fuzz:
        corpus["pinned"] = PINNED
        corpus["lines"] = [
            {"line": line, "status": status, "stderr": stderr}
            for line, (status, stderr) in zip(
                lines_checked, pinned, strict=True
            )
        ]
        FIXTURE.write_text(dumped(corpus))
    return 1 if disagree else 0


if __name__ == "__main__":
    sys.exit(main())
