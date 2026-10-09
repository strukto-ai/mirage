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
import re
import sys
from collections.abc import Callable, Iterable
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

from mirage.commands.cli.builtin.gh.constants import (
    CONNECT_HINT,
    GITHUB_HOST,
    GOJQ_RAISED,
)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import PartialOutputError, UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.core.github.config import GhConfig
from mirage.core.github.constants import API_BASE
from mirage.core.github.repo import RepoRef, parse_repo, repo_host
from mirage.core.jq import JqHalt, JqRun, jq_raised, jq_run
from mirage.errors.fs import fs_strerror
from mirage.io.stream import materialize, yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec


def check_host(config: GhConfig, host: str | None) -> None:
    """Refuse a repository on a host this install cannot reach.

    Real gh sends the request to whatever host a repository argument
    names; this one answers github.com, whose subdomains go-gh reads as
    github.com, and the host its ``base_url`` names. Any other host is
    one it cannot connect to, and it says so in gh's words (pinned
    against gh 2.85.0) rather than asking its own host for a repository
    of the same name.

    Args:
        config (GhConfig): the install's configuration.
        host (str | None): the host the argument named, if any.

    Raises:
        ValueError: the host is not one this install answers.
    """
    if host is None:
        return
    host = host.lower()
    if host == GITHUB_HOST or host.endswith(f".{GITHUB_HOST}"):
        return
    if config.base_url and urlsplit(config.base_url).hostname == host:
        return
    raise ValueError(f"error connecting to {host}\n{CONNECT_HINT}")


def web_origin(config: GhConfig) -> str:
    """The origin the install's GitHub serves its pages and git from:
    github.com for GitHub's own API, else the API host's own origin, as a
    GitHub Enterprise server and a local stand-in serve them.

    Args:
        config (GhConfig): the install's configuration.
    """
    base = config.base_url
    if base is None or base.rstrip("/") == API_BASE:
        return f"https://{GITHUB_HOST}"
    parts = urlsplit(base)
    return f"{parts.scheme}://{parts.netloc}"


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
            "no repository given; pass one or set `repo` on the install"
        )
    ref = parse_repo(named)
    check_host(config, repo_host(named))
    return ref


# gh's exporter writes with Go's encoding/json, which escapes U+2028 and
# U+2029 where json.dumps writes them raw. Every other character comes out
# the same (Go 1.22 and later spell \b and \f short, as json.dumps does),
# <, > and & raw too, since gh turns HTML escaping off.
_SEPARATORS = re.compile(r"[\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}]")


def _go_json(value: JsonValue) -> str:
    """One value as gh's exporter prints it: Go's compact JSON.

    Args:
        value (JsonValue): the value to print.
    """
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return _SEPARATORS.sub(lambda match: f"\\u{ord(match.group()):04x}", text)


def json_out(value: JsonValue) -> tuple[ByteSource | None, IOResult]:
    """``--json`` output as gh writes it where stdout is not a terminal,
    which in a workspace it never is: one compact line.

    Args:
        value (JsonValue): the selected fields.
    """
    text = "" if value is None else f"{_go_json(value)}\n"
    return yield_bytes(text.encode()), IOResult()


def text_out(text: str) -> tuple[ByteSource | None, IOResult]:
    return yield_bytes(text.encode()), IOResult()


def gh_bool(fl: FlagView, name: str) -> bool:
    """Whether a gh boolean flag is on: given bare, or as ``=true``.

    Args:
        fl (FlagView): the leaf's flags.
        name (str): the flag's name.
    """
    return fl.as_bool(name) or fl.as_str(name) == "true"


def repo_for(inv: CLIInvocation[GhConfig], fl: FlagView) -> RepoRef:
    """Resolve a typed verb's shared `-R/--repo` target."""
    return gh_repo(inv.config, fl.as_str("repo"))


def list_limit(fl: FlagView, default: int) -> int:
    """Preserve an explicit zero while applying a list command's default."""
    value = fl.as_int("limit")
    return default if value is None else value


def repo_number(
    inv: CLIInvocation[GhConfig],
    fl: FlagView,
    value: str | None,
    label: str,
    url_kind: str,
) -> tuple[RepoRef, int]:
    """Resolve a numeric subject or a full GitHub subject URL atomically."""
    raw = value or ""
    if raw.isdigit():
        return repo_for(inv, fl), int(raw)
    match = re.fullmatch(
        r"https?://[^/]+/([^/]+)/([^/]+)/(issues|pull)/(\d+)/?", raw
    )
    if match is None or match.group(3) != url_kind:
        raise ValueError(f"a {label} number is required")
    check_host(inv.config, urlsplit(raw).hostname)
    return parse_repo(f"{match.group(1)}/{match.group(2)}"), int(
        match.group(4)
    )


def csv_values(values: Iterable[str]) -> list[str]:
    """Expand repeatable comma-separated gh flags, preserving order."""
    return [
        item.strip()
        for value in values
        for item in value.split(",")
        if item.strip()
    ]


async def read_cli_file(
    inv: CLIInvocation[GhConfig], raw: FlagValue, option: str
) -> bytes:
    """Read a path-valued CLI option from the VFS, or `-` from stdin."""
    if not isinstance(raw, (str, PathSpec)):
        raise ValueError(f"{option} expects a file")
    path = raw.raw_path if isinstance(raw, PathSpec) else raw
    if path == "-":
        if inv.stdin is None:
            raise ValueError(f"{option} needs standard input")
        return await materialize(inv.stdin)
    spec = PathSpec.from_str_path(raw, cwd=inv.cwd)
    if inv.view is None or inv.view.dispatch is None:
        raise ValueError(f"{option} needs a workspace to read files from")
    try:
        data, _ = await inv.view.dispatch("read", spec)
        return await materialize(data)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise ValueError(f"read {path}: {fs_strerror(exc)}") from None


async def body_value(
    inv: CLIInvocation[GhConfig],
    fl: FlagView,
    *,
    value: str = "body",
    file: str = "body_file",
    required: bool = False,
) -> str | None:
    """Resolve mutually exclusive inline and file/stdin text options."""
    inline = fl.as_str(value)
    source = fl.raw(file)
    if inline is not None and source is not None:
        raise UsageError(
            f"--{value.replace('_', '-')} and "
            f"--{file.replace('_', '-')} are mutually exclusive"
        )
    if inline is not None:
        return inline
    if source is not None:
        return (
            await read_cli_file(inv, source, f"--{file.replace('_', '-')}")
        ).decode()
    if required:
        raise ValueError(
            f"--{value.replace('_', '-')} or "
            f"--{file.replace('_', '-')} is required"
        )
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


# Go's json.Marshal escapes <, > and & for HTML and U+2028 and U+2029 for
# JavaScript on top of the escapes json.dumps shares with it; gojq's own
# encoder escapes none of them, but does escape DEL.
_MARSHAL_ESCAPES = re.compile(
    r"[<>&\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}]"
)


def _go_number(number: int | float) -> str:
    """A number as Go's JSON encoders, gojq's among them, write a float64,
    which is how ES6 spells it: the shortest digits that read back the
    same, in exponent form below 1e-6 and from 1e21 on, anything past the
    largest finite float at that float.

    Args:
        number (int | float): the number.
    """
    bound = sys.float_info.max
    clamped = float(min(max(number, -bound), bound))
    digits = Decimal(repr(clamped))
    magnitude = abs(clamped)
    if magnitude != 0 and (magnitude < 1e-6 or magnitude >= 1e21):
        return f"{digits:e}"
    return f"{digits.normalize():f}"


def _marshal_string(text: str) -> str:
    """A string as Go's json.Marshal writes it.

    Args:
        text (str): the string.
    """
    return _MARSHAL_ESCAPES.sub(
        lambda match: f"\\u{ord(match.group()):04x}",
        json.dumps(text, ensure_ascii=False),
    )


def _gojq_string(text: str) -> str:
    """A string as gojq's encoder writes it into an error.

    Args:
        text (str): the string.
    """
    return json.dumps(text, ensure_ascii=False).replace("\x7f", "\\u007f")


def _go_encoded(value: JsonValue, quote: Callable[[str], str]) -> str:
    """A decoded JSON value as Go writes it back out: compact, object keys
    sorted as a Go map's are, every number a float64 (see _go_number) and
    every string as `quote` writes it.

    Args:
        value (JsonValue): the value.
        quote (Callable[[str], str]): how a string is written.
    """
    if isinstance(value, dict):
        pairs = (
            f"{quote(key)}:{_go_encoded(value[key], quote)}"
            for key in sorted(value)
        )
        return "{" + ",".join(pairs) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_go_encoded(item, quote) for item in value) + "]"
    if isinstance(value, str):
        return quote(value)
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    return _go_number(value)


def jq_line(value: Any) -> str:
    """One `--jq` output as go-gh prints it: a string raw, null as an empty
    line, a boolean as its word, a number in fixed notation, with no
    decimals when it is whole and two otherwise (rounded half to even, as
    strconv rounds), and anything else as Go's json.Marshal writes it.

    jq hands a whole number over as an int holding the double's exact
    value, which is what Go's fixed notation prints for it.

    Args:
        value (Any): one output of the program.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.0f}" if value.is_integer() else f"{value:.2f}"
    return _go_encoded(value, _marshal_string)


def _select(value: Any, fields: list[str]) -> Any:
    """Each row cut to the fields asked for, keys in sorted order: gh
    exports a Go map, which its JSON encoder always writes sorted.

    Args:
        value (Any): one row or a list of them.
        fields (list[str]): the ``--json`` fields.
    """
    rows = value if isinstance(value, list) else [value]
    keys = sorted(set(fields))
    selected: list[dict[str, Any]] = []
    for row in rows:
        source = row if isinstance(row, dict) else {}
        selected.append({field: source.get(field) for field in keys})
    return selected if isinstance(value, list) else selected[0]


def json_fields(fl: FlagView, allowed: Iterable[str]) -> list[str] | None:
    """The ``--json`` fields a line asked for, None without ``--json``.

    Checked before any request, as gh checks them: a field gh does not
    export is refused with gh's own message and every field it does,
    sorted, exit 1.

    Args:
        fl (FlagView): the line's flags.
        allowed (Iterable[str]): the fields the verb exports.
    """
    spelled = fl.as_str("json")
    if spelled is None:
        return None
    fields = csv_values([spelled])
    known = set(allowed)
    listing = [f"  {field}" for field in sorted(known)]
    if not fields:
        raise UsageError(
            "\n".join(
                [
                    "Specify one or more comma-separated fields for `--json`:",
                    *listing,
                ]
            ),
            1,
        )
    unknown = [field for field in fields if field not in known]
    if unknown:
        raise UsageError(
            "\n".join(
                [
                    f"Unknown JSON field: {json.dumps(unknown[0])}",
                    "Available fields:",
                    *listing,
                ]
            ),
            1,
        )
    return fields


def _gojq_text(text: str, string: bool) -> str:
    """A value jq printed, the way gojq's errors print it: a string as it
    is, anything else in gojq's own JSON.

    Args:
        text (str): the value as jq prints it.
        string (bool): whether the value was a string.
    """
    return text if string else _go_encoded(json.loads(text), _gojq_string)


def _jq_failure(
    value: JsonValue, program: str, run: JqRun[JsonValue]
) -> str | None:
    """The message go-gh fails with when a run stopped early, or None when
    that stop ends the output without failing.

    gojq reports an error the program raised with `error` as
    `error: <value>`, and a builtin's in gojq's own words, which mirage's
    jq does not share, so jq 1.8.2's stand; the builtins gojq writes in
    jq raise through `error` too (GOJQ_RAISED). A `halt_error` whose value
    is not null fails as `halt error: <value>`.

    Args:
        value (JsonValue): the value the program ran on.
        program (str): the `--jq` program.
        run (JqRun[JsonValue]): what jq_run returned for them.
    """
    stop = run.stop
    if stop is None:
        return None
    if isinstance(stop, JqHalt):
        if stop.message is None:
            return None
        return f"halt error: {_gojq_text(stop.message, stop.string)}"
    if jq_raised(value, program, run):
        return f"error: {_gojq_text(stop.text, stop.string)}"
    raised = GOJQ_RAISED.get(stop.text)
    return stop.text if raised is None else f"error: {raised}"


def jq_lines(values: Iterable[JsonValue], program: str) -> str:
    """The lines `--jq` prints for each value in turn, the way go-gh's jq
    evaluates them. `halt`, and `halt_error` on null, end that value's
    output there. An error, or any other `halt_error`, fails the command
    after the lines printed before it (see _jq_failure).

    Args:
        values (Iterable[JsonValue]): the JSON values the program reads.
        program (str): the `--jq` program.

    Raises:
        PartialOutputError: the failure, carrying the lines before it.
    """
    lines: list[str] = []
    for value in values:
        run = jq_run(value, program)
        lines.extend(f"{jq_line(item)}\n" for item in run.outputs)
        failure = _jq_failure(value, program, run)
        if failure is not None:
            raise PartialOutputError(failure, "".join(lines).encode())
    return "".join(lines)


async def typed_out(
    value: Any, fl: FlagView, human: str, allowed: Iterable[str]
) -> tuple[ByteSource | None, IOResult]:
    """Render a typed verb as stable projected JSON/jq or human text."""
    program = fl.as_str("jq")
    fields = json_fields(fl, allowed)
    if fields is None:
        if program:
            raise UsageError("--jq requires --json")
        return text_out(human)
    selected = _select(value, fields)
    if program:
        return text_out(jq_lines([selected], program))
    return json_out(selected)
