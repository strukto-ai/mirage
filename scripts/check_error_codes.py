"""Check that both servers register the same HTTP error codes, each with
the same status, and that the spec's ``Error.code`` lists every one.

The Python registry is ``ErrorCode`` and ``STATUS`` in
``python/mirage/server/errors.py``; the TypeScript one is the same pair in
``typescript/packages/server/src/errors.ts``. A server can only answer a
registered code (an enum in Python, a literal union in TypeScript), so
three equal tables keep every answer documented.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
PY = REPO / "python/mirage/server/errors.py"
TS = REPO / "typescript/packages/server/src/errors.ts"
SPEC = REPO / "docs/openapi.yaml"


def block(text: str, start: str) -> str:
    """The text from ``start`` to the first line that closes it.

    Args:
        text: The module source.
        start: The line that opens the block.
    """
    head = text.index(start)
    return text[head : text.index("\n}", head)]


def python_table() -> dict[str, int]:
    """Python's codes and their statuses, read from the source."""
    text = PY.read_text()
    names = dict(re.findall(r'^    ([A-Z_]+) = "([a-z_]+)"$', text, re.M))
    statuses = re.findall(r"ErrorCode\.([A-Z_]+): (\d{3}),", text)
    return {names[name]: int(status) for name, status in statuses}


def typescript_table() -> tuple[set[str], dict[str, int]]:
    """TypeScript's codes and their statuses, read from the source."""
    text = TS.read_text()
    codes = set(
        re.findall(
            r"^  [A-Z_]+: '([a-z_]+)',$",
            block(text, "export const ErrorCode"),
            re.M,
        )
    )
    statuses = re.findall(
        r"^  ([a-z_]+): (\d{3}),$", block(text, "export const STATUS"), re.M
    )
    return codes, {code: int(status) for code, status in statuses}


def spec_codes() -> set[str]:
    """The codes the spec's ``Error.code`` description names."""
    spec = yaml.safe_load(SPEC.read_text())
    code = spec["components"]["schemas"]["Error"]["properties"]["error"]
    described = code["properties"]["code"]["description"]
    return set(re.findall(r"`([a-z_]+)`", described))


def main() -> int:
    python = python_table()
    codes, typescript = typescript_table()
    problems: list[str] = []
    if set(python) != codes:
        problems.append(f"ErrorCode differs: {sorted(set(python) ^ codes)}")
    if python != typescript:
        problems.append(
            "STATUS differs: "
            + str(sorted(set(python.items()) ^ set(typescript.items())))
        )
    documented = spec_codes()
    if set(python) - documented:
        problems.append(
            f"Error.code does not name: {sorted(set(python) - documented)}"
        )
    if documented - set(python):
        problems.append(
            f"Error.code names unregistered: {sorted(documented - set(python))}"
        )
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
