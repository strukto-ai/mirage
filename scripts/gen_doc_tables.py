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
import asyncio
import collections.abc
import difflib
import inspect
import json
import re
import sys
import textwrap
import tomllib
import types
import typing
from collections.abc import Callable
from enum import Enum
from functools import partial
from pathlib import Path
from typing import NamedTuple

from pydantic import BaseModel
from pydantic.fields import FieldInfo
from typing_extensions import TypeForm

from mirage.commands.cli.specs import BUILTIN_CLI_SPECS, cli_spec_for
from mirage.types import JsonValue, MountMode
from mirage.vfs.machine.constants import LOCAL_PREFIXES
from mirage.vfs.registry import REGISTRY, build_vfs, resolve_class
from mirage.vfs.secrets import secret_field_names
from mirage.workspace import Workspace
from mirage.workspace.documentation.constants import INTRO
from mirage.workspace.documentation.render import fenced

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs" / "python"
AGENTS = ROOT / "python" / "mirage" / "agents"
SECRET_NOTE = "Fields marked secret are redacted in snapshots."
PYPROJECT = ROOT / "python" / "pyproject.toml"
EXTRA_FEATURES: tuple[tuple[str, tuple[str, ...], str], ...] = (
    (
        "Object stores",
        ("s3", "r2", "gcs", "oci"),
        "S3 and the S3-compatible VFS, such as R2, GCS, OCI and MinIO.",
    ),
    ("SSH", ("ssh",), "`SSHVFS` and the `ssh` machine."),
    (
        "OpenDAL",
        ("nextcloud", "hf-buckets"),
        "`NextcloudVFS` and `HfBucketsVFS`.",
    ),
    (
        "FUSE",
        ("fuse",),
        "Mounting a workspace as an OS filesystem; see the "
        "[FUSE setup](/python/setup/fuse).",
    ),
    ("MongoDB", ("mongodb", "gridfs"), "`MongoDBVFS` and `GridFSVFS`."),
    ("Postgres", ("postgres",), "`PostgresVFS`."),
    (
        "Redis",
        ("redis",),
        "`RedisVFS`, the Redis file and index cache stores, and the Redis "
        "session store.",
    ),
    ("Email", ("email",), "Sending mail with `himalaya` (SMTP)."),
    ("LanceDB", ("lancedb",), "`LanceDBVFS`."),
    ("Qdrant", ("qdrant",), "`QdrantVFS`."),
    ("Chroma", ("chroma",), "`ChromaVFS`."),
    ("Mem0", ("mem0",), "`Mem0VFS`."),
    ("Langfuse", ("langfuse",), "`LangfuseVFS`."),
    (
        "Runtimes",
        ("monty", "wasi", "quickjs"),
        "The [Monty](/python/runtime/monty), [WASI](/python/runtime/wasi) and "
        "[QuickJS](/python/runtime/quickjs) runtimes.",
    ),
    (
        "Cloud machines",
        ("e2b", "daytona", "boxd"),
        "The `e2b`, `daytona` and `boxd` machines.",
    ),
    ("AWS Secrets Manager", ("aws-sm",), "The `aws-sm` secret source."),
    ("1Password", ("1password",), "The `1password` secret source."),
    ("dotenv", ("dotenv",), "The `dotenv` secret source."),
    (
        "Agent SDKs",
        (
            "claude-agent-sdk",
            "claude-managed-agents",
            "openai",
            "agno",
            "deepagents",
            "pydantic-ai",
        ),
        "The adapters on the [agents pages](/python/agents/index).",
    ),
)
MIB = 1024 * 1024
MARKER = re.compile(
    r"^\{/\* generated: (?P<kind>[a-z-]+) (?P<key>[\w/.-]+)"
    r"(?: omit=(?P<omit>[\w,]+))? start \*/\}\n"
    r"(?P<body>.*?)"
    r"^\{/\* generated: (?P=kind) (?P=key) end \*/\}$",
    re.M | re.S,
)
TOKEN = re.compile(
    r"\{/\* generated: (?P<kind>[a-z-]+) (?P<key>[\w/.-]+)"
    r"(?: omit=[\w,]+)? (?P<edge>start|end) \*/\}"
)
CODE_SPAN = re.compile(r"(`+)(.+?)\1")
FRONTMATTER = re.compile(r"\A---\n.*?\n---\n+", re.S)
FENCE = re.compile(r"^`{3,}")
BOX = (
    '<div className="rounded-xl border border-gray-200 dark:border-gray-800 '
    'px-5 my-4">'
)
MODE_CELL = re.compile(r"^(\| `/<path>` \| (?:[^|]*, )?)write \|", re.M)
# The path a docs page mounts its VFS at: a mount goes wherever its
# workspace puts it.
PLACEHOLDER = "/<path>"
# A config each VFS builds from where a placeholder per required field is
# not one it accepts. Nothing is reached: building a VFS opens no
# connection.
# A machine mount needs a workspace with machines; one it never reaches.
MACHINES: dict[str, dict[str, JsonValue]] = {
    "machine": {"sandbox": {"provider": "docker", "container": "sandbox"}}
}
SAMPLES: dict[str, dict[str, JsonValue]] = {
    "box": {"access_token": "token"},
    "databricks_volume": {
        "host": "https://example.cloud.databricks.com",
        "token": "token",
        "catalog": "main",
        "schema": "default",
        "volume": "files",
    },
    "disk": {"root": "/"},
    "gcal": {"access_token": "token"},
    "gdocs": {"access_token": "token"},
    "gdrive": {"access_token": "token"},
    "github": {"token": "token", "owner": "owner", "repo": "repo"},
    "gmail": {"access_token": "token"},
    "gsheets": {"access_token": "token"},
    "gslides": {"access_token": "token"},
    "hf_buckets": {"bucket": "owner/bucket"},
    "mem0": {"api_key": "key", "user_id": "user"},
    "r2": {"bucket": "bucket", "account_id": "account"},
    "supabase": {
        "bucket": "bucket",
        "region": "us-east-1",
        "project_ref": "ref",
    },
    "tidb_filesystem": {
        "host": "https://aws-us-east-1.drive9.ai",
        "token": "token",
    },
}


class Rendered(NamedTuple):
    body: str
    bare: list[str]
    unknown: list[str]


Renderer = Callable[[frozenset[str]], Rendered]


def name_cell(name: str) -> str:
    """A field or symbol name that the table never breaks mid-token.

    Args:
        name (str): The identifier, made of word characters and dots.
    """
    return f"<code style={{{{ whiteSpace: 'nowrap' }}}}>{name}</code>"


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


def prose(text: str) -> str:
    """Escape prose for MDX outside a table, as ``cell`` does inside one.

    Args:
        text (str): A description, joined onto one line.
    """
    return cell(text).replace("\\|", "|")


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


def _default_text(field: FieldInfo) -> str:
    if field.is_required():
        return ""
    value = field.get_default(call_default_factory=True)
    if value is None:
        return ""
    if isinstance(value, Enum):
        value = value.value
    text = repr(value)
    if type(value) is int and value >= MIB and value % MIB == 0:
        text += f" ({value // MIB} MiB)"
    return text


def type_text(annotation: TypeForm[typing.Any] | None) -> str:
    """A field's type as a reader writes it: no ``None``, a secret as
    ``str`` and a literal as its values.

    Args:
        annotation (TypeForm[typing.Any] | None): The field's annotation.
    """
    if annotation is None or annotation is type(None):
        return ""
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)
    if origin is typing.Annotated:
        return type_text(args[0])
    if origin in (typing.Union, types.UnionType):
        parts = [type_text(a) for a in args if a is not type(None)]
        return " | ".join(dict.fromkeys(p for p in parts if p))
    if origin is typing.Literal:
        return " | ".join(repr(a) for a in args)
    if origin in (list, tuple, set, frozenset, collections.abc.Sequence):
        inner = type_text(args[0]) if args else ""
        return f"list[{inner}]" if inner else "list"
    if origin in (dict, collections.abc.Mapping):
        return "dict"
    if (
        origin is collections.abc.Callable
        or annotation is collections.abc.Callable
    ):
        return "callable"
    if isinstance(annotation, type):
        if issubclass(annotation, Enum):
            return " | ".join(repr(m.value) for m in annotation)
        if issubclass(annotation, BaseModel):
            return "object"
        if annotation.__name__ in ("SecretStr", "SecretBytes"):
            return "str"
        return annotation.__name__
    return getattr(annotation, "__name__", "") or str(annotation)


def _attr(text: str) -> str:
    return "{" + json.dumps(text) + "}"


def config_table(
    model: type[BaseModel], omit: frozenset[str] = frozenset()
) -> Rendered:
    """Render a config model as one ``ResponseField`` per field: its name,
    type, whether it is required, its default and whether it is secret.

    Args:
        model (type[BaseModel]): The VFS config model.
        omit (frozenset[str]): Wire names this page leaves out, because
            the mount it documents ignores them.
    """
    secrets = set(secret_field_names(model))
    blocks: list[str] = []
    bare: list[str] = []
    wires: set[str] = set()
    shows_secret = False
    for name, field in model.model_fields.items():
        wire = field.alias or name
        wires.add(wire)
        if wire in omit:
            continue
        text = description(model, name)
        if not text:
            bare.append(wire)
        attrs = [f'name="{wire}"']
        kind = type_text(field.annotation)
        if kind:
            attrs.append(f"type={_attr(kind)}")
        if field.is_required():
            attrs.append("required")
        default = _default_text(field)
        if default:
            attrs.append(f"default={_attr(default)}")
        if name in secrets:
            attrs.append('post={["secret"]}')
            shows_secret = True
        blocks.append(
            f"<ResponseField {' '.join(attrs)}>\n  {prose(text)}\n</ResponseField>"
        )
    note = f"\n\n{SECRET_NOTE}" if shows_secret else ""
    return Rendered("\n".join(blocks) + note, bare, sorted(omit - wires))


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


def exports_rows(
    exports: list[tuple[str, str]], omit: frozenset[str]
) -> Rendered:
    """Render public names as a table, one row per distinct summary.

    Names whose summaries are identical share a row, so a family of
    constants documented alike reads as one entry.

    Args:
        exports (list[tuple[str, str]]): Names in order, with summaries.
        omit (frozenset[str]): Names this page leaves out.
    """
    groups: dict[str, list[str]] = {}
    bare: list[str] = []
    for symbol, text in exports:
        if symbol in omit:
            continue
        if not text:
            bare.append(symbol)
            continue
        groups.setdefault(text, []).append(symbol)
    rows = ["| Symbol | Purpose |", "| --- | --- |"]
    for text, symbols in groups.items():
        names = "<br />".join(name_cell(s) for s in symbols)
        rows.append(f"| {names} | {cell(text)} |")
    known = {symbol for symbol, _ in exports}
    return Rendered("\n".join(rows), bare, sorted(omit - known))


def exports_table(name: str, omit: frozenset[str] = frozenset()) -> Rendered:
    """Render an adapter's public names as a Markdown table.

    Args:
        name (str): The adapter package under ``mirage.agents``.
        omit (frozenset[str]): Names this page leaves out.
    """
    return exports_rows(adapter_exports(name), omit)


def placeholder(annotation: TypeForm[typing.Any] | None) -> JsonValue:
    """A value of one required field's type that its model accepts.

    Args:
        annotation (TypeForm[typing.Any] | None): The field's annotation.
    """
    if annotation in (int, float):
        return 1
    if annotation is bool:
        return False
    if typing.get_origin(annotation) in (list, tuple):
        return ["value"]
    return "value"


def sample_config(
    name: str, model: type[BaseModel] | None
) -> dict[str, JsonValue]:
    """A config ``name`` builds from: a placeholder for each required field,
    or the sample it needs.

    Args:
        name (str): The registry name.
        model (type[BaseModel] | None): Its config model, if it has one.
    """
    if name in SAMPLES:
        return SAMPLES[name]
    if model is None:
        return {}
    return {
        field: placeholder(info.annotation)
        for field, info in model.model_fields.items()
        if info.is_required()
    }


def hidden(session_id: str | None) -> bool:
    return False


async def _vfs_md(name: str, config: dict[str, JsonValue]) -> str:
    vfs = build_vfs(name, dict(config))
    machines = MACHINES.get(name)
    ws = Workspace(
        {PLACEHOLDER: (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        machines=machines,
    )
    # The scratch root, /dev and the machines' own folders a workspace
    # adds are no part of this VFS, and the agent's opening paragraph is
    # no part of a docs page.
    for prefix in ("/", "/dev", *(LOCAL_PREFIXES if machines else ())):
        ws.mount(prefix).visible = hidden
    try:
        markdown = (await ws.vfs_md()).replace(INTRO + "\n\n", "", 1)
    finally:
        await ws.close()
    return MODE_CELL.sub(r"\1`<mode>` |", markdown, count=1)


def rendered(markdown: str) -> str:
    """``markdown`` as a docs page shows it: no frontmatter, and every
    heading a bold line, so none joins the page's own outline.

    Args:
        markdown (str): A VFS.md.
    """
    lines: list[str] = []
    fence = 0
    for line in FRONTMATTER.sub("", markdown).split("\n"):
        run = FENCE.match(line)
        bare = line.strip()
        if not fence and run:
            fence = len(run[0])
        elif fence and set(bare) == {"`"} and len(bare) >= fence:
            fence = 0
        elif not fence and line.startswith("#"):
            line = f"**{line.lstrip('#').strip()}**"
        lines.append(line)
    return "\n".join(lines)


def tabs(markdown: str) -> str:
    """``markdown`` rendered in one tab and as its source in another,
    boxed apart from the page around it.

    Args:
        markdown (str): A VFS.md.
    """
    shown = textwrap.indent(rendered(markdown), "    ")
    raw = textwrap.indent(fenced(markdown, "markdown"), "    ")
    return (
        f"{BOX}\n"
        '<Tabs>\n  <Tab title="Rendered">\n'
        f"{shown}\n  </Tab>\n"
        '  <Tab title="Raw">\n'
        f"{raw}\n  </Tab>\n</Tabs>\n</div>"
    )


def vfs_md(
    name: str,
    model: type[BaseModel] | None,
    omit: frozenset[str] = frozenset(),
) -> Rendered:
    """Render the VFS.md a workspace with ``name`` mounted writable at
    ``PLACEHOLDER`` answers, rendered and raw, one tab each.

    Args:
        name (str): The registry name.
        model (type[BaseModel] | None): Its config model, if it has one.
        omit (frozenset[str]): Nothing can be left out of a document.
    """
    markdown = asyncio.run(_vfs_md(name, sample_config(name, model)))
    return Rendered(tabs(markdown.rstrip("\n")), [], sorted(omit))


# A config each account CLI installs with. Nothing is reached: installing
# a CLI opens no connection.
CLI_SAMPLES: dict[str, dict[str, JsonValue]] = {
    "airtable": {"token": "token"},
    "discord": {"token": "token"},
    "gh": {"token": "token"},
    "gws": {
        "client_id": "id",
        "client_secret": "secret",
        "refresh_token": "token",
    },
    "hf": {"token": "token"},
    "himalaya": {
        "imap_host": "imap.example.com",
        "smtp_host": "smtp.example.com",
        "username": "agent@example.com",
        "password": "password",
    },
    "linear": {"api_key": "key"},
    "ntn": {"api_key": "key"},
    "slack": {"token": "token"},
    "trello": {"api_key": "key", "api_token": "token"},
}


async def _skill_md(name: str) -> str:
    ws = Workspace({})
    ws.register_cli(name, cli_spec_for(name), CLI_SAMPLES.get(name))
    try:
        return await ws.skill_md()
    finally:
        await ws.close()


def skill_md(name: str, omit: frozenset[str] = frozenset()) -> Rendered:
    """Render the SKILL.md a workspace with only ``name`` installed
    answers, rendered and raw, one tab each.

    Args:
        name (str): The bundled CLI.
        omit (frozenset[str]): Nothing can be left out of a document.
    """
    markdown = asyncio.run(_skill_md(name))
    return Rendered(tabs(markdown.rstrip("\n")), [], sorted(omit))


def extras_table(omit: frozenset[str] = frozenset()) -> Rendered:
    """Render the ``mirage-ai`` extras by feature, from pyproject.toml.

    Every extra is either mapped in ``EXTRA_FEATURES`` or a meta extra
    made only of other extras, so a new one fails the check until it is
    described here.

    Args:
        omit (frozenset[str]): Nothing can be left out of this table.
    """
    extras = tomllib.loads(PYPROJECT.read_text())["project"][
        "optional-dependencies"
    ]
    meta = {
        name: [dep[len("mirage-ai[") : -1] for dep in deps]
        for name, deps in extras.items()
        if deps and all(dep.startswith("mirage-ai[") for dep in deps)
    }
    mapped = [name for _, names, _ in EXTRA_FEATURES for name in names]
    unmapped = sorted(set(extras) - set(mapped) - set(meta))
    unknown = sorted(set(mapped) - set(extras))
    if unmapped or unknown or len(mapped) != len(set(mapped)):
        raise ValueError(
            f"EXTRA_FEATURES disagrees with pyproject.toml: unmapped "
            f"{unmapped or '-'}; not an extra {unknown or '-'}"
        )
    rows = ["| Feature | Extras | Needed for |", "| --- | --- | --- |"]
    for feature, names, needs in EXTRA_FEATURES:
        cell = ", ".join(f"`{name}`" for name in names)
        rows.append(f"| {feature} | {cell} | {needs} |")
    for name, members in sorted(meta.items()):
        left = [extra for extra in mapped if extra not in members]
        if len(left) < len(members):
            needs = "Every extra above" + (
                " except " + ", ".join(f"`{extra}`" for extra in left)
                if left
                else ""
            )
        else:
            needs = "The extras " + ", ".join(
                f"`{extra}`" for extra in members
            )
        rows.append(f"| Bundle | `{name}` | {needs}. |")
    return Rendered("\n".join(rows), [], sorted(omit))


def renderers() -> dict[str, dict[str, Renderer]]:
    """Each marker kind's keys, mapped to the function rendering one."""
    models = config_models()
    return {
        "config-table": {
            name: partial(config_table, model)
            for name, model in models.items()
        },
        "exports": {name: partial(exports_table, name) for name in adapters()},
        "extras": {"optional": extras_table},
        "vfs-md": {
            name: partial(vfs_md, name, models.get(name))
            for name in sorted(REGISTRY)
        },
        "skill-md": {
            name: partial(skill_md, name) for name in sorted(BUILTIN_CLI_SPECS)
        },
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
    """Prove the marker check refuses every unpaired shape, and the
    rendered VFS.md moves headings but never code."""
    start = "{/* generated: exports x start */}"
    end = "{/* generated: exports x end */}"
    table = "| a |\n| --- |"
    good = f"{start}\n{table}\n{end}\n"
    assert markers_paired(good)
    assert markers_paired(good.replace(" x start", " x omit=a,b start"))
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
    document = "---\nname: x\n---\n\n# T\n\n```text\n# kept\n```\n\n## S"
    assert rendered(document) == "**T**\n\n```text\n# kept\n```\n\n**S**"
    assert tabs(document).count("    # kept") == 2
    table = "| `/<path>` | `gcal`, write |\n| `/<path>` | write |"
    assert MODE_CELL.sub(r"\1`<mode>` |", table, count=1) == (
        "| `/<path>` | `gcal`, `<mode>` |\n| `/<path>` | write |"
    )
    assert type_text(int | None) == "int"
    assert type_text(typing.Literal["a", "b"]) == "'a' | 'b'"
    assert type_text(list[str] | None) == "list[str]"
    print("gen_doc_tables selftest: ok")


def regenerate(
    text: str,
    page: str,
    kinds: dict[str, dict[str, Renderer]],
    seen: set[tuple[str, str]],
    errors: list[str],
) -> str:
    """Rewrite every generated region of one page.

    Args:
        text (str): The page as it is on disk.
        page (str): The page's path, for messages.
        kinds (dict[str, dict[str, Renderer]]): The renderers, by marker
            kind and key.
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
        omit = frozenset((match["omit"] or "").split(",")) - {""}
        body, bare, unknown = fn(omit)
        if unknown:
            errors.append(
                f"{page}: `{kind} {key}` omits {', '.join(unknown)}, "
                "which it does not have"
            )
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
