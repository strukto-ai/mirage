import argparse
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "rust/mirage-rs/src/jq/corpus.json"

# The exit status of a case jq could not run at all, which the corpus
# leaves out.
SKIPPED = 2

# Programs jq refuses, beyond jq.test's own: one or more of each kind of
# compile error jq reports, as jq_eval must word them.
PROBES = [
    "1 +",
    "  1 +",
    "if",
    "if\n",
    "if . then 1",
    "[\n  try if .\n         then 1\n         else 2\n  catch ]",
    "1 == 2 == 3",
    "1 < 2 > 3",
    ". = 1 |= 2",
    "break",
    "break $x",
    "label $f | break $g",
    "f",
    "f(1)",
    "f($x)",
    "$x",
    "$__prog_args",
    "$x | $y",
    "[$x, f, g(1)]",
    "f(g) | h",
    "def f: $x; 1",
    "def f: $q; f",
    "def f: $y; f | $z",
    "def f($v): $v + $w; f(1)",
    "def f: 1; def g: f; g | h",
    "def f(g): g; f($a) | $b",
    ".[$x] = 1 | $z",
    "$a += $b",
    "reduce $a as $x ($b; $c)",
    "foreach $a as $x ($b; $c; $d)",
    "path($a) | $b",
    "map($a) | $b",
    "has($a) | $b",
    "limit($n; $m)",
    "map($a) + map($b)",
    '"\\(map($a))\\(map($b))"',
    ". as {a:$x, ($x):$y} | $y",
    ". as [$a] ?// $b | $c",
    "{$x: 1}",
    "{a: $x, $y}",
    '"\\($a)" | $b',
    "if $a then $b elif $c then $d else $e end",
    "try $a catch $b",
    "$a? // $b and $c",
    "$a[$b:$c]",
    "{(1):2, a: $q}",
    "{(1+1):2}",
    '{(["a"]):1}',
    '{({"a":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}):1}',
    "{(null):1}",
    ". as {(1):$x} | $x",
    '"\\x"',
    '"\\u12"',
    '"\\ud800"',
    '"abc',
    '"\\(1',
    '"\\(1]"',
    '@ "x"',
    "\u00e9",
    ".a.[",
    ".a | .[",
    ".[1:",
    "{",
    "}",
    ")",
    "]",
    "(1",
    "[1,2",
    "{a:1",
    "{a 1}",
    "{(1)}",
    "{1:2}",
    ". as $x",
    ". as $x |",
    ". as [$a, $b | $a",
    "reduce . as $x",
    "reduce . as $x (0)",
    "foreach . as $x (0; 1; 2; 3)",
    "def f: 1",
    "def f: 1;",
    "def f(: 1; f",
    "def if: 1; 1",
    "def f($a; b): 1; f(1; 2) | f(1)",
    "try",
    "try 1 catch",
    "if 1 then 2 else 3",
    "if 1 then 2 elif 3 end",
    ".a.b.c +",
    "1 as $x | 2 as $y | $z",
    "label | 1",
    "label $x 1",
    ". |",
    "| .",
    ", 1",
    "1,",
    "..a",
    ".. .a",
    ".[]?? | $x",
    "-",
    "1 -",
    "- -",
    "$",
    "$$",
    "$$$$x",
    "@base64d @base64",
    'import "a" as $x; .',
    'import "a" as x; .',
    'include "a"',
    "module {a:1}; .a | $x",
    "module 1; .",
    "1 # comment\n+",
    "# only a comment",
    "1 # comment \\\n continued\n+",
    "\t1 +\t",
    "1\n+\n",
    ".a\n|\n$x\n|\n.b",
    "(1;2)",
    "[1;2]",
    "f(1,2;3",
    "$__loc__ | $x",
    "{$__loc__} | $y",
    "1 as [$a, {b: $c, $d}] | [$a, $c, $d, $e]",
    "[.[] | {a: $x}]",
    ". as [$a] ?// {$b} | $a, $b, $c",
    "input_filename | $x",
    "ltrimstr($a) | $b",
    "splits($a) | $b",
    "getpath($a) | $b",
    "first(f) | g",
    "nosuch(1) | nosuch(2)",
    ". as $x | def f: $x; f | $y",
    "def f: def g: $q; g; f",
    "def f: def g: 3; $q; f",
    '@text "\\($x)"',
    '"a" as $x | "\\($x) \\($y)"',
    "[limit(3; .[])] | $x",
    "1 as $x | $x as $y | $z",
    ". as [$x, $x] | $y",
    "{a:1} | .a as $a | {$a, $b}",
    "if . then error else $e end",
    "try error($x) catch .",
    "$ENV.PATH | $x",
    "env | $x",
    "now | $x",
    'test("a") | $x',
    "input | $x",
    "debug | $x",
    "1 as $x | [$x, $y] | .[$z]",
]


def groups(text: str) -> list[tuple[list[str], bool]]:
    """The test groups of jq's tests/jq.test: a program, its input, then
    the outputs, a blank line after each, and whether it is a `%%FAIL`
    group, which tests a compile error. Comments are left out.

    Args:
        text (str): the file's contents.
    """
    out: list[tuple[list[str], bool]] = []
    current: list[str] = []
    failing = False
    for line in [*text.split("\n"), ""]:
        if line.startswith("#"):
            continue
        if not line.strip():
            if current:
                out.append((current, failing))
            current, failing = [], False
        elif line.startswith("%%FAIL"):
            failing = True
        else:
            current.append(line)
    return out


def run(
    jq: str, program: str, document: str
) -> subprocess.CompletedProcess[bytes]:
    """Run `program` over `document` with a jq 1.8.2 binary and -c.

    Args:
        jq (str): the binary.
        program (str): the jq program.
        document (str): its input.
    """
    return subprocess.run(
        [jq, "-c", program],
        input=document.encode(),
        capture_output=True,
        timeout=30,
        check=False,
    )


def main() -> None:
    """Rebuild the jq evaluator's corpus: each jq.test program run over
    its input by a jq 1.8.2 binary with -c, keeping what it printed; the
    `%%FAIL` groups and PROBES run over null, for jq's compile errors."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "jq_test", type=pathlib.Path, help="jq 1.8.2 tests/jq.test"
    )
    parser.add_argument("jq", help="a jq 1.8.2 binary")
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=OUT,
        help="where to write the corpus (tests/onig.test's goes to onig.json)",
    )
    args = parser.parse_args()
    cases = []
    found = groups(args.jq_test.read_text())
    tests = [group for group, failing in found if not failing]
    fails = [group for group, failing in found if failing]
    stem = args.jq_test.stem
    sources = [
        (f"{stem}_test_{at:04d}", group[0], group[1])
        for at, group in enumerate(tests)
        if len(group) >= 2
    ]
    sources += [
        (f"{stem}_fail_{at:04d}", group[0], "null")
        for at, group in enumerate(fails)
    ]
    if stem == "jq":
        sources += [
            (f"probe_{at:04d}", program, "null")
            for at, program in enumerate(PROBES)
        ]
    for case_id, program, document in sources:
        done = run(args.jq, program, document)
        if done.returncode == SKIPPED:
            continue
        cases.append(
            {
                "id": case_id,
                "program": program,
                "input": document,
                "outputs": done.stdout.decode().split("\n")[:-1],
                "stderr": done.stderr.decode(),
                "exit": done.returncode,
            }
        )
    out = args.out.resolve()
    out.write_text(json.dumps(cases, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {len(cases)} cases to {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
