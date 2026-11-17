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
import ast
import json
import re
import sys
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from vulture import Vulture

ROOT = Path(__file__).resolve().parent.parent
SOURCE = "python/mirage"
CALLERS = ("python/tests", "integ", "examples", "scripts")
TESTS = "python/tests"
EXCLUDE = ["*/node_modules/*", "*/.venv/*", "*/dist/*"]
EXCEPTIONS = ROOT / "scripts/parity/dead_code_exceptions.json"

# A framework calls these by the route or verb they register, never by name.
FRAMEWORK_DECORATORS = [
    "@*.command",
    "@*.callback",
    "@*.get",
    "@*.post",
    "@*.put",
    "@*.patch",
    "@*.delete",
    "@*.websocket",
    "@field_validator",
    "@model_validator",
    "@field_serializer",
    "@model_serializer",
    "@pytest.fixture",
]

# A shape's fields are its contract: an enum member is reached through its
# value, a model or record field through whoever builds or serializes it.
SHAPE_BASES = frozenset(
    {
        "Enum",
        "StrEnum",
        "IntEnum",
        "Flag",
        "IntFlag",
        "TypedDict",
        "NamedTuple",
        "BaseModel",
        "Protocol",
    }
)

IMPORT_STRING = re.compile(r"""["'](mirage(?:\.\w+)*):(\w+)["']""")


@dataclass(frozen=True)
class Finding:
    path: str
    name: str
    kind: str
    line: int


def _base_name(node: ast.expr) -> str:
    if isinstance(node, ast.Subscript):
        node = node.value
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _is_dataclass(node: ast.ClassDef) -> bool:
    for decorator in node.decorator_list:
        if isinstance(decorator, ast.Call):
            decorator = decorator.func
        if _base_name(decorator) == "dataclass":
            return True
    return False


def shape_classes(trees: Iterable[ast.Module]) -> set[str]:
    """The names of every class whose body is a shape's fields.

    A class is a shape when it is a dataclass or derives, directly or
    through first-party classes, from an enum, a typed record, a pydantic
    model or a protocol. Classes are matched by name, so two classes of
    one name share a verdict.

    Args:
        trees (Iterable[ast.Module]): every scanned module.
    """
    bases: dict[str, set[str]] = {}
    shapes: set[str] = set()
    for tree in trees:
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            bases.setdefault(node.name, set()).update(
                _base_name(base) for base in node.bases
            )
            if _is_dataclass(node):
                shapes.add(node.name)
    grew = True
    while grew:
        grew = False
        for name, parents in bases.items():
            if name not in shapes and parents & (SHAPE_BASES | shapes):
                shapes.add(name)
                grew = True
    return shapes


def shape_field_lines(tree: ast.Module, shapes: set[str]) -> set[int]:
    """The lines that declare a field directly in a shape class's body.

    Args:
        tree (ast.Module): the module.
        shapes (set[str]): the shape class names.
    """
    lines: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name in shapes:
            for stmt in node.body:
                if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                    lines.add(stmt.lineno)
    return lines


def module_file(root: Path, module: str) -> str | None:
    """The source file a dotted ``mirage`` module path names.

    Args:
        root (Path): the repository root.
        module (str): a dotted module path.
    """
    base = root / "python" / Path(*module.split("."))
    for candidate in (base.with_suffix(".py"), base / "__init__.py"):
        if candidate.is_file():
            return candidate.relative_to(root).as_posix()
    return None


def python_files(root: Path, tops: Iterable[str]) -> list[Path]:
    """Every Python file under the given directories.

    Args:
        root (Path): the repository root.
        tops (Iterable[str]): directories relative to ``root``.
    """
    files: list[Path] = []
    for top in tops:
        directory = root / top
        if not directory.is_dir():
            continue
        files.extend(
            path
            for path in sorted(directory.rglob("*.py"))
            if not {"node_modules", ".venv", "dist"} & set(path.parts)
        )
    return files


def import_strings(root: Path, files: Iterable[Path]) -> set[tuple[str, str]]:
    """The ``(file, name)`` pairs a ``"mirage.mod:name"`` string reaches.

    An entry point or an import string loads its target by name, which no
    reference in the code shows.

    Args:
        root (Path): the repository root.
        files (Iterable[Path]): the files to read, pyproject.toml among
            them.
    """
    reached: set[tuple[str, str]] = set()
    for path in files:
        for module, name in IMPORT_STRING.findall(path.read_text()):
            target = module_file(root, module)
            if target is not None:
                reached.add((target, name))
    return reached


def findings(root: Path, tests_call: bool = True) -> list[Finding]:
    """What vulture finds unused in ``python/mirage``.

    Args:
        root (Path): the repository root.
        tests_call (bool): count the test suite as a caller.
    """
    callers = [c for c in CALLERS if tests_call or c != TESTS]
    source = python_files(root, [SOURCE])
    scanned = source + python_files(root, callers)
    vulture = Vulture(ignore_decorators=FRAMEWORK_DECORATORS)
    vulture.scavenge([str(path) for path in scanned], exclude=EXCLUDE)
    trees = {
        path.relative_to(root).as_posix(): ast.parse(path.read_text())
        for path in source
    }
    shapes = shape_classes(trees.values())
    fields = {
        path: shape_field_lines(tree, shapes) for path, tree in trees.items()
    }
    reached = import_strings(root, [*scanned, root / "python/pyproject.toml"])
    found: list[Finding] = []
    for item in vulture.get_unused_code():
        path = Path(item.filename).resolve().relative_to(root).as_posix()
        if not path.startswith(SOURCE + "/"):
            continue
        if item.typ == "variable" and item.first_lineno in fields[path]:
            continue
        if (path, item.name) in reached:
            continue
        found.append(Finding(path, item.name, item.typ, item.first_lineno))
    return found


def judge(
    found: list[Finding], excused: dict[str, dict[str, str | list[str]]]
) -> tuple[list[Finding], list[str]]:
    """Split findings into the unexcused and the excuses nothing needs.

    Args:
        found (list[Finding]): what vulture reports.
        excused (dict): per file, a reason and the names it excuses.
    """
    names = {
        (path, name)
        for path, entry in excused.items()
        for name in entry["names"]
    }
    unexcused = [f for f in found if (f.path, f.name) not in names]
    seen = {(f.path, f.name) for f in found}
    stale = sorted(f"{path}: {name}" for path, name in names - seen)
    return unexcused, stale


def report(unexcused: list[Finding], stale: list[str]) -> None:
    for f in unexcused:
        print(f"  {f.path}:{f.line}: unused {f.kind} '{f.name}'")
    for entry in stale:
        print(f"  stale excuse (no longer reported, drop it): {entry}")


SELFTEST_SOURCE = """
import enum
from dataclasses import dataclass

import typer

app = typer.Typer()


def gone():
    return 1


def kept():
    return Mode, Shape, Plain


def by_string():
    return 3


def only_tested():
    return 4


def excused_hook():
    return 5


@app.command()
def verb():
    return kept()


class Mode(enum.Enum):
    ON = "on"
    OFF = "off"


@dataclass
class Shape:
    width: int = 0


class Plain:
    LIMIT = 3
"""

SELFTEST_CALLER = 'TARGET = "mirage.m:by_string"\n'

SELFTEST_TEST = "from mirage.m import only_tested\n\nonly_tested()\n"


def selftest() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        (root / SOURCE).mkdir(parents=True)
        (root / SOURCE / "__init__.py").write_text("")
        (root / SOURCE / "m.py").write_text(SELFTEST_SOURCE)
        (root / "scripts").mkdir()
        (root / "scripts/caller.py").write_text(SELFTEST_CALLER)
        (root / TESTS).mkdir(parents=True)
        (root / TESTS / "test_m.py").write_text(SELFTEST_TEST)
        (root / "python/pyproject.toml").write_text("")
        path = f"{SOURCE}/m.py"
        excused: dict[str, dict[str, str | list[str]]] = {
            path: {"reason": "selftest", "names": ["excused_hook", "vanished"]}
        }
        unexcused, stale = judge(findings(root), excused)
        got = sorted(f.name for f in unexcused)
        expected = ["LIMIT", "gone"]
        if got != expected:
            print(f"selftest: flagged {got}, expected {expected}")
            return 1
        if stale != [f"{path}: vanished"]:
            print(f"selftest: stale {stale}, expected the vanished excuse")
            return 1
        bare = {f.name for f in findings(root, tests_call=False)}
        if "only_tested" not in bare:
            print(
                "selftest: a test-only symbol was not reported without tests"
            )
            return 1
    print("selftest: ok")
    return 0


def main() -> int:
    # Every finding that is not dead code is excused by file, with its
    # reason, in dead_code_exceptions.json. --strict fails on a new finding
    # and on an excuse nothing needs. --without-tests lists what only the
    # test suite reaches, for a person to read; it never fails.
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--without-tests", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    excused = json.loads(EXCEPTIONS.read_text())
    found = findings(ROOT)
    unexcused, stale = judge(found, excused)
    if args.without_tests:
        seen = {(f.path, f.name) for f in found}
        tested, _ = judge(findings(ROOT, tests_call=False), excused)
        only = [f for f in tested if (f.path, f.name) not in seen]
        for f in only:
            print(f"  {f.path}:{f.line}: only tests reach {f.kind} '{f.name}'")
        print(f"symbols only the tests reach: {len(only)}")
        return 0
    report(unexcused, stale)
    held = sum(len(entry["names"]) for entry in excused.values())
    print(f"excused findings: {held} in {len(excused)} files")
    print(f"unexcused dead code in {SOURCE}: {len(unexcused)} (baseline 0)")
    print(f"stale excuses: {len(stale)} (baseline 0)")
    return 1 if args.strict and (unexcused or stale) else 0


if __name__ == "__main__":
    sys.exit(main())
