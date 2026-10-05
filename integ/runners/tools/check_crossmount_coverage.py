import argparse
import ast
import json
import shlex
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
NAMESPACE_COMMANDS = {
    "chmod",
    "chown",
    "chgrp",
    "getfattr",
    "setfattr",
    "ln",
    "readlink",
}


def registered_commands(root: Path) -> set[str]:
    """Read the command vocabulary without importing backend dependencies.

    Args:
        root (Path): Repository checkout.
    """
    source = (
        root / "python/mirage/commands/builtin/generic/crossmount/types.py"
    )
    tree = ast.parse(source.read_text())
    enum = next(
        n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Cmd"
    )
    return {
        n.value.value
        for n in enum.body
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant)
    }


def coverage_errors(
    commands: set[str], cases: dict[str, list[dict]]
) -> list[str]:
    """Require an executable success case in each command's own folder.

    This is a registration gate, not proof of every flag or backend. A case
    must name the command, contain both mount prefixes (possibly in a
    symlink setup), assert all three result channels, and run on RAM and
    disk. Topology suites can supplement but cannot replace this case.

    Args:
        commands (set[str]): Registered and namespace command names.
        cases (dict[str, list[dict]]): Cases grouped by command folder.
    """
    errors = []
    seen: set[str] = set()
    for rows in cases.values():
        for case in rows:
            if case["id"] in seen:
                errors.append(f"duplicate crossmount case id: {case['id']}")
            seen.add(case["id"])
    for command in sorted(commands):
        covered = False
        for case in cases.get(command, []):
            line = case["command"]
            expected = case.get("expect", {})
            tokens = shlex.split(line, posix=True)
            if (
                command in tokens
                and "/data/" in line
                and "/data2/" in line
                and expected.get("exit") == 0
                and {"stdout", "stderr"} <= expected.keys()
                and {"ram", "disk"} <= set(case.get("targets", []))
            ):
                covered = True
                break
        if not covered:
            errors.append(
                f"{command}: add a success case in integ/crossmount/{command}/"
            )
    return errors


def selftest() -> None:
    case = {
        "id": "copy",
        "command": "cp /data/a /data2/a",
        "targets": ["ram", "disk"],
        "expect": {"exit": 0, "stdout": "", "stderr": ""},
    }
    assert coverage_errors({"cp"}, {"cp": [case]}) == []
    assert coverage_errors({"cp", "mv"}, {"cp": [case]})
    assert coverage_errors({"cp"}, {"misc": [case]})
    assert coverage_errors({"cp"}, {"cp": [case, case]})
    for change in (
        {"command": "cp --help"},
        {"command": "cp /data/a /data/b"},
        {"targets": ["ram"]},
        {"expect": {"exit": 1, "stdout": "", "stderr": "failure"}},
        {"expect": {"exit": 0}},
    ):
        assert coverage_errors({"cp"}, {"cp": [case | change]})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
    cases: dict[str, list[dict]] = {}
    for path in sorted((ROOT / "integ/crossmount").rglob("*.json")):
        folder = path.relative_to(ROOT / "integ/crossmount").parts[0]
        data = json.loads(path.read_text())
        cases.setdefault(folder, []).extend(
            {"targets": data.get("targets", []), **case}
            for case in data["cases"]
        )
    commands = registered_commands(ROOT) | NAMESPACE_COMMANDS
    errors = coverage_errors(commands, cases)
    if errors:
        raise SystemExit("\n".join(errors))
    print(
        f"crossmount coverage: {len(commands)} commands have named integration cases"
    )


if __name__ == "__main__":
    main()
