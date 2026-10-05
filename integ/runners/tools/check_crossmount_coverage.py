# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import argparse
import json
import re
import shlex
from pathlib import Path

from mirage.commands.builtin.generic.crossmount.constants import (
    CROSS_MOUNT_COMMANDS,
)

ROOT = Path(__file__).resolve().parents[3]
# The operators and keywords after which a shell word runs as a command.
CONTROL = frozenset(
    {";", "|", "||", "&&", "&", "(", ")", "{", "}", "!"}
    | {"if", "then", "elif", "else", "while", "until", "do"}
)
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
NAMESPACE_COMMANDS = {
    "chmod",
    "chown",
    "chgrp",
    "getfattr",
    "setfattr",
    "ln",
    "readlink",
}


def invoked_commands(line: str) -> set[str]:
    """The words a shell line runs as commands, not as their arguments.

    A word is in command position at the start of the line or after a
    control operator or keyword, past any ``NAME=value`` assignments.

    Args:
        line (str): One case's command line.
    """
    lexer = shlex.shlex(line, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    names: set[str] = set()
    expect = True
    for token in lexer:
        if token in CONTROL:
            expect = True
        elif expect and not ASSIGNMENT.match(token):
            names.add(token)
            expect = False
    return names


def coverage_errors(
    commands: set[str], cases: dict[str, list[dict]]
) -> list[str]:
    """Require an executable success case in each command's own folder.

    This is a registration gate, not proof of every flag or backend. A case
    must run the command, contain both mount prefixes (possibly in a
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
            if (
                command in invoked_commands(line)
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
    for line in ("FOO=1 cp /data/a /data2/a", "true && cp /data/a /data2/a"):
        assert (
            coverage_errors({"cp"}, {"cp": [case | {"command": line}]}) == []
        )
    for change in (
        {"command": "echo cp /data/a /data2/a"},
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
    commands = set(CROSS_MOUNT_COMMANDS) | NAMESPACE_COMMANDS
    errors = coverage_errors(commands, cases)
    if errors:
        raise SystemExit("\n".join(errors))
    print(
        f"crossmount coverage: {len(commands)} commands have named integration cases"
    )


if __name__ == "__main__":
    main()
