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

from mirage.shell.bytes import decode_text  # noqa: E402
from mirage.shell.parse import parse, syntax_refusal  # noqa: E402

FIXTURES = REPO / "integ" / "fixtures" / "shell" / "bash_syntax"
IMAGE = "debian:stable-slim"
PINNED = (
    "bash 5.2.37 (debian:stable-slim), C locale, parse only: bash -n -c LINE"
)
HEAD = "bash: -c: "

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


def pin(lines: list[str]) -> list[tuple[int, str]]:
    """Run each line through bash's parser in docker.

    Args:
        lines (list[str]): the lines.

    Returns:
        list[tuple[int, str]]: per line, bash's status and the stderr mirage
        prints for it (``refusal_stderr``).
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
        results.append((status, refusal_stderr(err) if status else ""))
    return results


def refusal_stderr(err: str) -> str:
    """What mirage prints of a line bash refuses: bash's diagnostic lines
    as bash prints them, the echo of the offending line included, less the
    heredoc warnings, which mirage prints as the line runs; a warning's
    delimiter may span lines.

    Args:
        err (str): bash's stderr.
    """
    out: list[str] = []
    until = ""
    for raw in err.split("\n") if err else []:
        line = PREFIX.sub("", raw)
        if until:
            until = "" if line.endswith(until) else until
            continue
        if line.startswith("warning:") or raw.startswith("bash: warning:"):
            if "(wanted `" in line and not line.endswith("')"):
                until = "')"
            continue
        out.append(raw)
    return "".join(f"{line}\n" for line in out)


def kind_of(status: int, stderr: str) -> str:
    """The fixture a row goes in, by what bash does with its line: reads
    it, or refuses an array, a substitution's body, a ``[[``, a
    ``for ((;;))`` header, input ending inside a construct, or a token.

    Args:
        status (int): bash's status.
        stderr (str): what mirage prints (``refusal_stderr``).
    """
    if status == 0:
        return "reads"
    if status == 1:
        return "array"
    if status == 127:
        return "substitution"
    first = PREFIX.sub("", stderr.split("\n", 1)[0])
    if "conditional" in stderr or "`]]'" in stderr or "expected `)'" in stderr:
        return "conditional"
    if first.startswith(("syntax error: arithmetic", "syntax error: `;'")):
        return "arithmetic"
    if "unexpected end of file" in first or "unexpected EOF" in first:
        return "unclosed"
    return "near_token"


def corpus_rows() -> list[dict[str, Any]]:
    """Every row of every fixture."""
    return [
        row
        for path in sorted(FIXTURES.glob("*.json"))
        for row in json.loads(path.read_text())["lines"]
    ]


def dumped(rows: list[dict[str, Any]]) -> str:
    """A fixture's text, one line per row so a re-pin diffs by line.

    Args:
        rows (list[dict[str, Any]]): the rows.
    """
    lines = ",\n".join(
        "  " + json.dumps(row, ensure_ascii=False) for row in rows
    )
    pinned = json.dumps(PINNED)
    return f'{{\n "pinned": {pinned},\n "lines": [\n{lines}\n ]\n}}\n'


def checked(line: str) -> tuple[int, str]:
    """mirage's status and stderr for a line, read with extglob off as
    `bash -n` reads it.

    Args:
        line (str): the line.
    """
    io = syntax_refusal(parse(line, extglob=False), HEAD, 1, utf8=False)
    if io is None:
        return (0, "")
    assert isinstance(io.stderr, bytes)
    return (io.exit_code, decode_text(io.stderr))


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
    corpus = corpus_rows()
    if args.fuzz:
        rng = random.Random(args.seed)
        lines: set[str] = set()
        for row in corpus:
            if row["status"] == 0:
                lines.update(mutations(row["line"], rng, args.fuzz))
        lines_checked = sorted(lines)
    else:
        lines_checked = sorted({row["line"] for row in corpus})
    pinned = pin(lines_checked)
    disagree = 0
    for line, expected in zip(lines_checked, pinned, strict=True):
        if checked(line) != expected:
            disagree += 1
            print(f"{line!r}\n  bash   {expected}\n  mirage {checked(line)}")
    print(f"{len(lines_checked) - disagree}/{len(lines_checked)} lines agree")
    if not args.fuzz:
        kinds: dict[str, list[dict[str, Any]]] = {}
        for line, (status, stderr) in zip(lines_checked, pinned, strict=True):
            kinds.setdefault(kind_of(status, stderr), []).append(
                {"line": line, "status": status, "stderr": stderr}
            )
        for path in FIXTURES.glob("*.json"):
            if path.stem not in kinds:
                path.unlink()
        FIXTURES.mkdir(exist_ok=True)
        for kind, rows in kinds.items():
            (FIXTURES / f"{kind}.json").write_text(dumped(rows))
    return 1 if disagree else 0


if __name__ == "__main__":
    sys.exit(main())
