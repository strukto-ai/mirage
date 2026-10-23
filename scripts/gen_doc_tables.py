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
import difflib
import inspect
import re
import sys
from collections.abc import Callable
from enum import Enum
from functools import partial
from pathlib import Path

from pydantic import BaseModel
from pydantic.fields import FieldInfo

from mirage.vfs.registry import REGISTRY, resolve_class
from mirage.vfs.secrets import secret_field_names

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs" / "python"
AGENTS = ROOT / "python" / "mirage" / "agents"
SECRET_NOTE = "Redacted in snapshots."
MARKER = re.compile(
    r"^\{/\* generated: (?P<kind>[a-z-]+) (?P<key>[\w/.-]+) start \*/\}\n"
    r"(?P<body>.*?)"
    r"^\{/\* generated: (?P=kind) (?P=key) end \*/\}$",
    re.M | re.S,
)
TOKEN = re.compile(
    r"\{/\* generated: (?P<kind>[a-z-]+) (?P<key>[\w/.-]+) "
    r"(?P<edge>start|end) \*/\}"
)
CODE_SPAN = re.compile(r"(`+)(.+?)\1")


def cell(text: str) -> str:
    """Escape prose for one Markdown table cell in MDX.

    Code spans keep their text, since MDX shows an entity inside one
    literally; outside them a brace or an angle bracket would open an
    expression or a tag.

    Args:
        text (str): A description, joined onto one line.
    """
    out: list[str] = []
    last = 0
    flat = " ".join(text.split())
    for match in CODE_SPAN.finditer(flat):
        out.append(_escape_prose(flat[last : match.start()]))
        out.append(match.group(0).replace("|", "\\|"))
        last = match.end()
    out.append(_escape_prose(flat[last:]))
    return "".join(out)


def _escape_prose(text: str) -> str:
    return (
        text.replace("|", "\\|")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("{", "&#123;")
        .replace("}", "&#125;")
    )


def summary(doc: str | None) -> str:
    """The first paragraph of a docstring, on one line.

    Args:
        doc (str | None): The cleaned docstring, if any.
    """
    if not doc:
        return ""
    return " ".join(doc.strip().split("\n\n", 1)[0].split())


def config_models() -> dict[str, type[BaseModel]]:
    """Every registry name whose VFS is configured by a pydantic model.

    A name built from raw kwargs (ram, disk, redis) has no model, so it
    has no table either.
    """
    out: dict[str, type[BaseModel]] = {}
    for name in sorted(REGISTRY):
        entry = REGISTRY[name]
        ref = entry.config_path
        if ref is None:
            ref = getattr(resolve_class(entry.vfs_path), "CONFIG_CLS", None)
        if ref is None:
            continue
        model = resolve_class(ref) if isinstance(ref, str) else ref
        if not issubclass(model, BaseModel):
            raise TypeError(f"{name}: {ref!r} is not a pydantic model")
        out[name] = model
    return out


def _attribute_docstrings(cls: type) -> dict[str, str]:
    """The string statement under each annotated field of one class.

    Args:
        cls (type): A class whose own source declares the fields.
    """
    tree = ast.parse(inspect.getsource(cls).lstrip())
    body = tree.body[0].body if isinstance(tree.body[0], ast.ClassDef) else []
    out: dict[str, str] = {}
    for node, after in zip(body, body[1:]):
        if (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and isinstance(after, ast.Expr)
            and isinstance(after.value, ast.Constant)
            and isinstance(after.value.value, str)
        ):
            out[node.target.id] = inspect.cleandoc(after.value.value)
    return out


def description(model: type[BaseModel], name: str) -> str:
    """A field's description: ``Field(description=...)`` or its docstring.

    A subclass that redeclares a field only to change its default or
    requiredness keeps the meaning its base documented, so the classes
    are searched in MRO order for the first that says something.

    Args:
        model (type[BaseModel]): The config model.
        name (str): The field's attribute name.
    """
    for cls in model.__mro__:
        if not (isinstance(cls, type) and issubclass(cls, BaseModel)):
            continue
        if name not in cls.__dict__.get("__annotations__", {}):
            continue
        field = cls.model_fields.get(name)
        if field is not None and field.description:
            return field.description.strip()
        doc = _attribute_docstrings(cls).get(name)
        if doc:
            return doc
    return ""


def _default_cell(field: FieldInfo) -> str:
    if field.is_required():
        return ""
    value = field.get_default(call_default_factory=True)
    if value is None:
        return ""
    if isinstance(value, Enum):
        value = value.value
    return f"`{value!r}`".replace("|", "\\|")


def config_table(model: type[BaseModel]) -> tuple[str, list[str]]:
    """Render a config model as a Markdown table.

    Args:
        model (type[BaseModel]): The VFS config model.

    Returns:
        tuple[str, list[str]]: The table, and the wire names of the fields
            that carry no description.
    """
    secrets = set(secret_field_names(model))
    rows = [
        "| Field | Required | Default | Description |",
        "| --- | --- | --- | --- |",
    ]
    bare: list[str] = []
    for name, field in model.model_fields.items():
        wire = field.alias or name
        text = description(model, name)
        if not text:
            bare.append(wire)
        if name in secrets:
            text = f"{text} {SECRET_NOTE}".strip()
        rows.append(
            f"| `{wire}` | {'yes' if field.is_required() else 'no'} "
            f"| {_default_cell(field)} | {cell(text)} |"
        )
    return "\n".join(rows), bare


def _module_file(module: str) -> Path:
    base = ROOT / "python" / Path(*module.split("."))
    package = base / "__init__.py"
    return package if package.exists() else base.with_suffix(".py")


def _absolute(node: ast.ImportFrom, package: str) -> str:
    if node.level == 0:
        return node.module or ""
    parts = package.split(".")
    head = parts[: len(parts) - node.level + 1]
    return ".".join([*head, *([node.module] if node.module else [])])


def _docstring(module: str, name: str, depth: int = 0) -> str | None:
    """The docstring a module gives the object it binds to ``name``.

    A class or function carries its own. A constant carries the string
    statement right after its assignment, the attribute docstring
    convention pydantic and Sphinx read. An import is followed to the
    module it names, so a package that re-exports a name reports the
    definition's text without importing the adapter's framework.

    Args:
        module (str): Dotted module path to start from.
        name (str): The bound name.
        depth (int): Re-export hops taken so far.
    """
    if depth > 8:
        raise SystemExit(f"{module}.{name}: re-exports do not converge")
    path = _module_file(module)
    tree = ast.parse(path.read_text())
    package = (
        module if path.name == "__init__.py" else module.rsplit(".", 1)[0]
    )
    body = tree.body
    for i, node in enumerate(body):
        if (
            isinstance(
                node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
            )
            and node.name == name
        ):
            return ast.get_docstring(node)
        targets = (
            node.targets
            if isinstance(node, ast.Assign)
            else [node.target]
            if isinstance(node, ast.AnnAssign)
            else []
        )
        if any(isinstance(t, ast.Name) and t.id == name for t in targets):
            after = body[i + 1] if i + 1 < len(body) else None
            if (
                isinstance(after, ast.Expr)
                and isinstance(after.value, ast.Constant)
                and isinstance(after.value.value, str)
            ):
                return inspect.cleandoc(after.value.value)
            return None
    for imported in ast.walk(tree):
        if isinstance(imported, ast.ImportFrom) and any(
            (alias.asname or alias.name) == name for alias in imported.names
        ):
            source = next(
                alias.name
                for alias in imported.names
                if (alias.asname or alias.name) == name
            )
            return _docstring(_absolute(imported, package), source, depth + 1)
    raise SystemExit(f"{module}: no definition or import of {name}")


def adapter_exports(name: str) -> list[tuple[str, str]]:
    """The public names of one agent adapter, with their summaries.

    Args:
        name (str): The adapter package under ``mirage.agents``.

    Returns:
        list[tuple[str, str]]: ``__all__`` in order, each with the first
            paragraph of its docstring.
    """
    module = f"mirage.agents.{name}"
    tree = ast.parse(_module_file(module).read_text())
    names: list[str] | None = None
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and any(
                isinstance(t, ast.Name) and t.id == "__all__"
                for t in node.targets
            )
            and isinstance(node.value, (ast.List, ast.Tuple))
        ):
            names = [
                elt.value
                for elt in node.value.elts
                if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
            ]
    if names is None:
        raise SystemExit(f"{module} declares no literal __all__")
    return [(n, summary(_docstring(module, n))) for n in names]


def adapters() -> list[str]:
    """Every agent adapter package, by its directory name."""
    return sorted(
        p.parent.name
        for p in AGENTS.glob("*/__init__.py")
        if not p.parent.name.startswith("_")
    )


def exports_table(name: str) -> tuple[str, list[str]]:
    """Render an adapter's public names as a Markdown table.

    Args:
        name (str): The adapter package under ``mirage.agents``.

    Returns:
        tuple[str, list[str]]: The table, and the names with no summary.
    """
    rows = ["| Symbol | Purpose |", "| --- | --- |"]
    bare: list[str] = []
    for symbol, text in adapter_exports(name):
        if not text:
            bare.append(symbol)
        rows.append(f"| `{symbol}` | {cell(text)} |")
    return "\n".join(rows), bare


def renderers() -> dict[str, dict[str, Callable[[], tuple[str, list[str]]]]]:
    """Each marker kind's keys, mapped to the function rendering one."""
    models = config_models()
    return {
        "config-table": {
            name: partial(config_table, model)
            for name, model in models.items()
        },
        "exports": {name: partial(exports_table, name) for name in adapters()},
    }


def markers_paired(text: str) -> bool:
    """Whether every marker opens or closes exactly one region, in order.

    A start with no end, an end with no start, a repeated end or two
    starts in a row would each leave rows outside every region, which
    the check could then never compare.

    Args:
        text (str): The page as it is on disk.
    """
    current: tuple[str, str] | None = None
    starts = 0
    for match in TOKEN.finditer(text):
        marker = (match["kind"], match["key"])
        if match["edge"] == "start":
            if current is not None:
                return False
            current = marker
            starts += 1
        elif current != marker:
            return False
        else:
            current = None
    return current is None and starts == len(MARKER.findall(text))


def selftest() -> None:
    """Prove the marker check refuses every unpaired shape."""
    start = "{/* generated: exports x start */}"
    end = "{/* generated: exports x end */}"
    table = "| a |\n| --- |"
    good = f"{start}\n{table}\n{end}\n"
    assert markers_paired(good)
    assert markers_paired("no markers\n")
    for broken in (
        f"{table}\n{end}\n",
        f"{good}{end}\n",
        f"{start}\n{table}\n",
        f"{start}\n{start}\n{table}\n{end}\n",
        f"{start}\n{table}\n{{/* generated: exports y end */}}\n",
        f"{start} {table} {end}\n",
    ):
        assert not markers_paired(broken), broken
    print("gen_doc_tables selftest: ok")


def regenerate(
    text: str,
    page: str,
    kinds: dict[str, dict[str, Callable[[], tuple[str, list[str]]]]],
    seen: set[tuple[str, str]],
    errors: list[str],
) -> str:
    """Rewrite every generated region of one page.

    Args:
        text (str): The page as it is on disk.
        page (str): The page's path, for messages.
        kinds (dict[str, dict[str, Callable[[], tuple[str, list[str]]]]]):
            The renderers, by marker kind and key.
        seen (set[tuple[str, str]]): Collects the regions found.
        errors (list[str]): Collects the problems found.
    """
    if not markers_paired(text):
        errors.append(
            f"{page}: generated markers must pair up, each start followed "
            "by its own end on a line of its own"
        )

    def render(match: re.Match[str]) -> str:
        kind, key = match["kind"], match["key"]
        fn = kinds.get(kind, {}).get(key)
        if fn is None:
            errors.append(f"{page}: nothing generates `{kind} {key}`")
            return match.group(0)
        seen.add((kind, key))
        body, bare = fn()
        if bare:
            errors.append(
                f"{page}: `{kind} {key}` renders without a description "
                f"for {', '.join(bare)}; describe them in the code"
            )
        start = match.group(0).split("\n", 1)[0]
        end = match.group(0).rsplit("\n", 1)[1]
        return f"{start}\n{body}\n{end}"

    return MARKER.sub(render, text)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate the schema-derived tables in docs/python"
    )
    parser.add_argument(
        "--check", action="store_true", help="Fail on a stale table"
    )
    parser.add_argument(
        "--selftest", action="store_true", help="Test the marker check"
    )
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return 0
    kinds = renderers()
    seen: set[tuple[str, str]] = set()
    errors: list[str] = []
    stale: list[str] = []
    for path in sorted(DOCS.rglob("*.mdx")):
        page = str(path.relative_to(ROOT))
        text = path.read_text()
        if "{/* generated:" not in text:
            continue
        updated = regenerate(text, page, kinds, seen, errors)
        if updated == text:
            continue
        stale.append(page)
        if args.check:
            sys.stdout.writelines(
                difflib.unified_diff(
                    text.splitlines(keepends=True),
                    updated.splitlines(keepends=True),
                    fromfile=page,
                    tofile=f"{page} (generated)",
                )
            )
        else:
            path.write_text(updated)
    for kind, keys in kinds.items():
        for key in sorted(keys):
            if (kind, key) not in seen:
                print(f"note: no page in docs/python carries `{kind} {key}`")
    if errors:
        raise SystemExit("\n".join(errors))
    if args.check and stale:
        raise SystemExit(
            "Stale doc tables; run "
            "./python/.venv/bin/python scripts/gen_doc_tables.py:\n"
            + "\n".join(stale)
        )
    print(
        f"doc tables {'checked' if args.check else 'generated'}: "
        f"{len(seen)} regions"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
