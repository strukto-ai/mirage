import argparse
import json
import os
import re
import subprocess
import tempfile
import textwrap
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OLD_LEGS = {
    "a": "path/cwd path/rename path/stat",
    "b": (
        "path/exists path/link path/remove path/symlink "
        "path/unlink path/utime path/xattr"
    ),
    "c": "open dir/readdir",
    "d": "dir/glob dir/mkdir dir/rmdir dir/walk facade",
    "e": "read routing workspace",
    "f": (
        "write/capacity write/exit write/fd write/order write/parallel "
        "write/pwrite write/sync write/truncate write/writev"
    ),
    "g": "policy program quickjs write/write",
}


def select(names: list[str], entries: str) -> list[str]:
    """Expand suite or folder selectors, refusing overlaps and unknown names.

    Args:
        names (list[str]): every discovered runtime suite.
        entries (str): space-separated selectors from the workflow.
    """
    selected: list[str] = []
    for entry in entries.split():
        matches = [
            name
            for name in names
            if name == entry or name.startswith(entry + "/")
        ]
        if not matches:
            raise ValueError(f"unknown suite or folder: {entry}")
        selected.extend(matches)
    if not selected:
        raise ValueError("empty suite selection")
    duplicates = [
        name for name, count in Counter(selected).items() if count > 1
    ]
    if duplicates:
        raise ValueError(f"suites selected more than once: {duplicates}")
    return sorted(selected)


def partition(
    names: list[str], selectors: dict[str, str], remainder: str
) -> dict[str, list[str]]:
    """Partition the complete inventory, including optional backend suites.

    Args:
        names (list[str]): all discovered runtime suite names.
        selectors (dict[str, str]): the named legs' selectors.
        remainder (str): the leg assigned otherwise-unclaimed suites.
    """
    parts = {leg: select(names, entries) for leg, entries in selectors.items()}
    claimed = Counter(name for part in parts.values() for name in part)
    duplicates = [name for name, count in claimed.items() if count > 1]
    if duplicates:
        raise ValueError(f"suites claimed more than once: {duplicates}")
    parts[remainder] = sorted(set(names) - claimed.keys())
    if not parts[remainder]:
        raise ValueError(f"leg {remainder} is empty")
    return parts


def workflow() -> tuple[str, list[str], dict[str, str], str]:
    """Read the actual runtime matrix, selectors and resolver from the workflow."""
    text = (ROOT / ".github/workflows/test_integ.yml").read_text()
    block = text.split("  integ-runtime:\n", 1)[1]
    block = re.split(r"^  [a-z][a-z0-9-]*:\n", block, maxsplit=1, flags=re.M)[
        0
    ]
    matrix = re.search(r"^        leg: \[([^\]]+)\]$", block, re.M)
    if matrix is None:
        raise ValueError("runtime matrix must declare its legs")
    legs = [name.strip() for name in matrix[1].split(",")]
    selectors = {
        leg.lower(): json.loads(value)
        for leg, value in re.findall(
            r'^      LEG_([A-Z0-9]+)_SUITES: (".*")$', block, re.M
        )
    }
    resolver = block.split("      - name: Resolve this leg's suites\n", 1)[1]
    resolver = resolver.split("        run: |\n", 1)[1]
    resolver = re.split(r"^      - ", resolver, maxsplit=1, flags=re.M)[0]
    return block, legs, selectors, textwrap.dedent(resolver)


def check() -> tuple[list[str], dict[str, str], dict[str, list[str]], str]:
    """Prove each suite occurs once and only C, G and H are subdivided."""
    names = sorted(
        str(path.relative_to(ROOT / "integ/runtime").with_suffix(""))
        for path in (ROOT / "integ/runtime").rglob("*.json")
    )
    if any(
        re.fullmatch(r"[a-z0-9_+]+/[a-z0-9_+]+", name) is None
        for name in names
    ):
        raise ValueError(
            "runtime suites must use <folder>/<name> in [a-z0-9_+]"
        )
    block, legs, selectors, resolver = workflow()
    parts = partition(names, selectors, "h3")
    if len(legs) != len(set(legs)) or set(legs) != set(parts):
        raise ValueError("runtime matrix and suite partitions disagree")
    old = partition(names, OLD_LEGS, "h")
    for leg in "abcdefgh":
        children = (
            [leg] if leg in "abdef" else [leg + str(i) for i in range(1, 4)]
        )
        actual = sorted(name for child in children for name in parts[child])
        if actual != old[leg]:
            raise ValueError(f"new {children} do not partition old leg {leg}")
    if sorted(name for part in parts.values() for name in part) != names:
        raise ValueError(
            "runtime suites are not an exhaustive disjoint partition"
        )
    compatibility = {
        "pyodide/network",
        "pyodide/invoke",
        "pyodide/containment",
    }
    owners = [
        leg for leg, suites in parts.items() if "pyodide/network" in suites
    ]
    if len(owners) != 1 or not compatibility <= set(parts[owners[0]]):
        raise ValueError("oldest Pyodide suites must share exactly one leg")
    if block.count("contains(env.SUITES, 'pyodide/network')") != 1:
        raise ValueError(
            "oldest Pyodide check must run once on its suite's leg"
        )
    if (
        "runtime/run.ts pyodide/network pyodide/invoke pyodide/containment"
        not in block
    ):
        raise ValueError("oldest Pyodide compatibility coverage changed")
    if "INTEG_RUNTIMES:" in block:
        raise ValueError(
            "runtime partitions must keep every supported interpreter"
        )
    return names, selectors, parts, resolver


def selftest(
    names: list[str],
    selectors: dict[str, str],
    parts: dict[str, list[str]],
    resolver: str,
) -> None:
    """Exercise the workflow's own selection shell without running any suite.

    Args:
        names (list[str]): the discovered suite inventory.
        selectors (dict[str, str]): workflow selector declarations.
        parts (dict[str, list[str]]): the expected disjoint partitions.
        resolver (str): the actual workflow resolver shell.
    """
    resolver = resolver[resolver.index("all=$(printf") :]
    prefix = "set -euo pipefail\nexport LC_ALL=C\n"
    prefix += "names=(" + " ".join(names) + ")\n"
    prefix += (
        "minio_suites=(unused)\nwasi_suites=(unused)\n"
        "box_suites=(unused)\nssh_suites=(unused)\n"
    )
    base = {
        f"LEG_{leg.upper()}_SUITES": entries
        for leg, entries in selectors.items()
    }
    probes = [(leg, {}, suites) for leg, suites in parts.items()]
    probes.extend(
        [
            ("gone", {}, None),
            ("a", {"LEG_A_SUITES": "gone"}, None),
            ("a", {"LEG_A_SUITES": ""}, None),
            ("a", {"LEG_A_SUITES": "path/cwd path/cwd"}, None),
            ("a", {"LEG_A_SUITES": "path path/cwd"}, None),
            ("a", {"LEG_A_SUITES": selectors["b"]}, None),
        ]
    )
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "env"
        for leg, changes, expected in probes:
            output.write_text("")
            proc = subprocess.run(
                ["bash", "-c", prefix + resolver],
                cwd=ROOT,
                env={
                    **os.environ,
                    **base,
                    **changes,
                    "LEG": leg,
                    "GITHUB_ENV": str(output),
                },
                capture_output=True,
                text=True,
            )
            if expected is None:
                if proc.returncode == 0:
                    raise ValueError(
                        f"invalid partition accepted: {leg}, {changes}"
                    )
            else:
                if proc.returncode != 0:
                    raise ValueError(proc.stderr)
                actual = (
                    output.read_text()
                    .split("SUITES=", 1)[1]
                    .splitlines()[0]
                    .split()
                )
                if actual != expected:
                    raise ValueError(
                        f"workflow resolver differs for leg {leg}"
                    )
    print(
        f"runtime resolver: {len(probes)} positive and rejection probes passed"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    names, selectors, parts, resolver = check()
    if args.selftest:
        selftest(names, selectors, parts, resolver)
    print(
        f"runtime partition: {len(names)} suites across {len(parts)} disjoint legs; "
        "old eight-leg inventory preserved"
    )


if __name__ == "__main__":
    main()
