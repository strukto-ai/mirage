import argparse
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "rust/mirage-rs/src/jq/corpus.json"

# Exit statuses of cases the corpus leaves out: the program does not
# compile (3), or jq could not run it at all (2).
SKIPPED = {2, 3}


def groups(text: str) -> list[list[str]]:
    """The test groups of jq's tests/jq.test: a program, its input, then
    the outputs, a blank line after each. `%%FAIL` groups test compile
    errors and are left out, as are comments.

    Args:
        text (str): the file's contents.
    """
    out: list[list[str]] = []
    current: list[str] = []
    failing = False
    for line in [*text.split("\n"), ""]:
        if line.startswith("#"):
            continue
        if not line.strip():
            if current and not failing:
                out.append(current)
            current, failing = [], False
        elif line.startswith("%%FAIL"):
            failing = True
        else:
            current.append(line)
    return out


def main() -> None:
    """Rebuild the jq evaluator's corpus: each jq.test program run over
    its input by a jq 1.8.2 binary with -c, keeping what it printed."""
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
    for at, group in enumerate(groups(args.jq_test.read_text())):
        if len(group) < 2:
            continue
        program, document = group[0], group[1]
        done = subprocess.run(
            [args.jq, "-c", program],
            input=document.encode(),
            capture_output=True,
            timeout=30,
            check=False,
        )
        if done.returncode in SKIPPED:
            continue
        cases.append(
            {
                "id": f"{args.jq_test.stem}_test_{at:04d}",
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
