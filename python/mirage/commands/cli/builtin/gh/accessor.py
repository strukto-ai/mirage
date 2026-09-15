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

import json
import posixpath
import re
from collections.abc import Iterable
from typing import Any

from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import RepoRef, parse_repo
from mirage.core.jq import jq_eval
from mirage.io.stream import materialize, yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec


def gh_repo(config: GhConfig, spec: str | None) -> RepoRef:
    """The repository a line is about.

    The operand when it named one, the install's own otherwise. Real gh
    resolves this from the current git remote, which a workspace has no
    equivalent of, so the config carries it.

    Args:
        config (GhConfig): the install's configuration.
        spec (str | None): the repository the line named, if any.

    Returns:
        RepoRef: the owner and repository names.

    Raises:
        ValueError: neither the line nor the install named one.
    """
    named = spec if spec else config.repo
    if not named:
        raise ValueError(
            "no repository given; pass one or set `repo` on the install")
    return parse_repo(named)


def json_out(value: JsonValue) -> tuple[ByteSource | None, IOResult]:
    text = "" if value is None else f"{json.dumps(value, indent=2)}\n"
    return yield_bytes(text.encode()), IOResult()


def text_out(text: str) -> tuple[ByteSource | None, IOResult]:
    return yield_bytes(text.encode()), IOResult()


def repo_for(inv: CLIInvocation[GhConfig], fl: FlagView) -> RepoRef:
    """Resolve a typed verb's shared `-R/--repo` target."""
    return gh_repo(inv.config, fl.as_str("repo"))


def list_limit(fl: FlagView, default: int) -> int:
    """Preserve an explicit zero while applying a list command's default."""
    value = fl.as_int("limit")
    return default if value is None else value


def repo_number(inv: CLIInvocation[GhConfig], fl: FlagView, value: str | None,
                label: str, url_kind: str) -> tuple[RepoRef, int]:
    """Resolve a numeric subject or a full GitHub subject URL atomically."""
    raw = value or ""
    if raw.isdigit():
        return repo_for(inv, fl), int(raw)
    match = re.fullmatch(
        r"https?://[^/]+/([^/]+)/([^/]+)/(issues|pull)/(\d+)/?", raw)
    if match is None or match.group(3) != url_kind:
        raise ValueError(f"a {label} number is required")
    return parse_repo(f"{match.group(1)}/{match.group(2)}"), int(
        match.group(4))


def csv_values(values: Iterable[str]) -> list[str]:
    """Expand repeatable comma-separated gh flags, preserving order."""
    return [
        item.strip() for value in values for item in value.split(",")
        if item.strip()
    ]


def _dash_option(inv: CLIInvocation[GhConfig], options: tuple[str,
                                                              ...]) -> bool:
    return any(
        word == f"{option}=-" or (len(option) == 2 and word == f"{option}-") or
        (word == option and index + 1 < len(inv.argv) and inv.argv[index +
                                                                   1] == "-")
        for option in options for index, word in enumerate(inv.argv))


async def read_cli_file(inv: CLIInvocation[GhConfig], raw: FlagValue,
                        option: str, *aliases: str) -> bytes:
    """Read a path-valued CLI option from the VFS, or `-` from stdin."""
    if isinstance(raw, PathSpec):
        path = "-" if raw.raw_path == "-" or _dash_option(
            inv, (option, *aliases)) else raw.virtual
        spec = raw
    elif isinstance(raw, str):
        path = raw
        cwd = inv.env.get("PWD", "/")
        virtual = path if path.startswith("/") else posixpath.normpath(
            posixpath.join(cwd, path))
        spec = PathSpec.from_str_path(virtual)
    else:
        raise ValueError(f"{option} expects a file")
    if path == "-":
        if inv.stdin is None:
            raise ValueError(f"{option} needs standard input")
        return await materialize(inv.stdin)
    if inv.doors is None or inv.doors.dispatch is None:
        raise ValueError(f"{option} needs a workspace to read files from")
    try:
        data, _ = await inv.doors.dispatch("read", spec)
    except FileNotFoundError:
        raise ValueError(f"read {path}: No such file or directory") from None
    return data if isinstance(data, bytes) else bytes(data)


async def body_value(inv: CLIInvocation[GhConfig],
                     fl: FlagView,
                     *,
                     value: str = "body",
                     file: str = "body_file",
                     required: bool = False) -> str | None:
    """Resolve mutually exclusive inline and file/stdin text options."""
    inline = fl.as_str(value)
    source = fl.raw(file)
    if inline is not None and source is not None:
        raise UsageError(f"--{value.replace('_', '-')} and "
                         f"--{file.replace('_', '-')} are mutually exclusive")
    if inline is not None:
        return inline
    if source is not None:
        return (await read_cli_file(inv, source, f"--{file.replace('_', '-')}",
                                    "-F")).decode()
    if required:
        raise ValueError(f"--{value.replace('_', '-')} or "
                         f"--{file.replace('_', '-')} is required")
    return None


def camel_key(key: str) -> str:
    """Convert one REST snake_case key to gh's JSON field spelling."""
    head, *tail = key.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def camel(value: Any) -> Any:
    """Recursively normalize REST objects for typed gh JSON output."""
    if isinstance(value, list):
        return [camel(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {camel_key(str(key)): camel(item) for key, item in value.items()}
    if "htmlUrl" in result:
        result["url"] = result.pop("htmlUrl")
    if "user" in result:
        result["author"] = result.pop("user")
    return result


def jq_line(value: Any) -> str:
    """Render one jq result in gh's raw-output mode."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _select(value: Any, fields: list[str]) -> Any:
    rows = value if isinstance(value, list) else [value]
    selected: list[dict[str, Any]] = []
    for row in rows:
        source = row if isinstance(row, dict) else {}
        selected.append({field: source.get(field) for field in fields})
    return selected if isinstance(value, list) else selected[0]


async def typed_out(
        value: Any, fl: FlagView, human: str,
        allowed: Iterable[str]) -> tuple[ByteSource | None, IOResult]:
    """Render a typed verb as stable projected JSON/jq or human text."""
    json_fields = fl.as_str("json")
    program = fl.as_str("jq")
    if json_fields is None:
        if program:
            raise UsageError("--jq requires --json")
        return text_out(human)
    fields = csv_values([json_fields])
    known = set(allowed)
    unknown = [field for field in fields if field not in known]
    if unknown:
        raise UsageError(f"unknown JSON field: {unknown[0]}")
    selected = _select(value, fields)
    if program:
        lines = "".join(f"{jq_line(item)}\n"
                        for item in jq_eval(selected, program))
        return text_out(lines)
    return json_out(selected)
