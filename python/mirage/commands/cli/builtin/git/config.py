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

import posixpath
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from io import BytesIO

from dulwich.config import ConfigFile

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.errors import (
    BadConfigValueError,
    BadNumericConfigError,
    ConfigUsageError,
    GitError,
)
from mirage.commands.cli.builtin.git.io import read_optional
from mirage.commands.cli.builtin.git.session import inside
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    WIDE_INT_BITS,
    command_line_config,
    config_int,
    maybe_bool,
    parse_config_key,
    require_vfs,
    start_point,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import RegexError
from mirage.rs.regex import posix_regex
from mirage.shell.bytes import byte_view, encode_text, utf8_locale
from mirage.types import PathSpec

SYSTEM_CONFIG = "/etc/gitconfig"
SCOPE_LOCAL = "local"
SCOPE_GLOBAL = "global"
SCOPE_SYSTEM = "system"
SCOPE_COMMAND = "command"
COMMAND_LINE_ORIGIN = "command line:"
WRITING_SUBCOMMANDS = (
    "set",
    "unset",
    "rename-section",
    "remove-section",
    "edit",
)
# The value types mirage renders; git's others paint or read dates.
VALUE_KINDS = ("bool", "int", "bool-or-int", "path")
OTHER_VALUE_KINDS = ("bool-or-str", "color", "expiry-date")
INVALID_REGEX_EXIT = 6


@dataclass(frozen=True, slots=True)
class Variable:
    """One value a config source holds.

    Args:
        scope (str): the name ``--show-scope`` prints.
        origin (str): the label ``--show-origin`` prints.
        name (str): the dotted key, section and name lowercased.
        value (str | None): the value, None for a bare name.
    """

    scope: str
    origin: str
    name: str
    value: str | None


@dataclass(frozen=True, slots=True)
class Query:
    """What one invocation asks of the variables.

    Args:
        listing (bool): every variable.
        regexp (bool): the name is a regular expression.
        every (bool): every match rather than the last.
        names (bool): print each match's name too.
    """

    listing: bool = False
    regexp: bool = False
    every: bool = False
    names: bool = False


def config_key(key: str) -> str:
    parts = key.split(".")
    parts[0] = parts[0].lower()
    parts[-1] = parts[-1].lower()
    return ".".join(parts)


def _parsed(cfg: ConfigFile, scope: str, origin: str) -> list[Variable]:
    """Every variable one config file holds.

    Args:
        cfg (ConfigFile): the parsed file.
        scope (str): the file's scope.
        origin (str): the file's label.
    """
    return [
        Variable(
            scope,
            origin,
            b".".join((*section, name.lower())).decode(
                "utf-8", "surrogateescape"
            ),
            value.decode("utf-8", "surrogateescape"),
        )
        for section in cfg.sections()
        for name, value in cfg.items(section)
    ]


async def global_sources(
    ctx: Context, listing: bool
) -> list[tuple[str, ConfigFile]]:
    """The per-user config files ``--global`` reads, in git's order.

    ``$GIT_CONFIG_GLOBAL`` alone when set, else the XDG file then
    ``~/.gitconfig``, each read through the dispatcher from the
    session's own ``HOME`` so the answer is the workspace's and never
    the host's. Only ``--list`` refuses when neither exists.

    Args:
        ctx (Context): the line's context, for its env and files.
        listing (bool): ``--list`` was given.
    """
    vfs = require_vfs(ctx)
    env = ctx.env or {}
    home = env.get("HOME", "")
    override = env.get("GIT_CONFIG_GLOBAL")
    if override is None and not home:
        raise GitError("$HOME not set")
    target = override or posixpath.join(home, ".gitconfig")
    xdg = env.get("XDG_CONFIG_HOME") or posixpath.join(home, ".config")
    paths = (
        [target]
        if override is not None
        else [posixpath.join(xdg, "git/config"), target]
    )
    sources = []
    for source in paths:
        data = await read_optional(
            vfs, PathSpec.from_str_path(source, cwd="/")
        )
        if data is not None:
            sources.append((source, ConfigFile.from_file(BytesIO(data))))
    if not sources and listing:
        raise GitError(
            f"unable to read config file '{target}': No such file or directory"
        )
    return sources


def _missing_file(path: str) -> GitError:
    return GitError(
        f"unable to read config file '{path}': No such file or directory"
    )


async def _system_variables(ctx: Context, listing: bool) -> list[Variable]:
    """The machine-wide config, as the workspace sees it.

    Args:
        ctx (Context): the line's context.
        listing (bool): refuse when the file is missing.
    """
    env = ctx.env or {}
    path = env.get("GIT_CONFIG_SYSTEM", SYSTEM_CONFIG)
    data = await read_optional(
        require_vfs(ctx), PathSpec.from_str_path(path, cwd="/")
    )
    if data is None:
        if listing:
            raise _missing_file(path)
        return []
    return _parsed(
        ConfigFile.from_file(BytesIO(data)), SCOPE_SYSTEM, f"file:{path}"
    )


async def _local_variables(
    ctx: Context, fl: FlagView, location: RepoLocation
) -> list[Variable]:
    """The repository's own config.

    git names it from the top of the work tree it moved to, so an
    ordinary checkout reads ``.git/config`` from anywhere inside it.

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.
        location (RepoLocation): the discovered repository.
    """
    path = location.commondir.join("config")
    data = await read_optional(require_vfs(ctx), path)
    ordinary = (
        location.commondir.virtual == location.worktree.virtual + "/.git"
    )
    start = start_point(fl).virtual
    inside = start == location.worktree.virtual or start.startswith(
        location.worktree.virtual + "/"
    )
    label = ".git/config" if ordinary and inside else path.raw_path
    return _parsed(
        ConfigFile.from_file(BytesIO(data or b"")),
        SCOPE_LOCAL,
        f"file:{label}",
    )


def _command_variables(ctx: Context) -> list[Variable]:
    """What ``-c`` and ``--config-env`` set, last in every default read.

    Args:
        ctx (Context): the line's context.
    """
    return [
        Variable(SCOPE_COMMAND, COMMAND_LINE_ORIGIN, name, value)
        for name, value in command_line_config(ctx)
    ]


async def _variables_of(
    ctx: Context, fl: FlagView, listing: bool
) -> list[Variable]:
    """The variables the line's scope reads, in the order git reads them.

    Without a scope that is every file then the command line; a scope
    names one file, and ``--list`` then refuses a missing one.

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.
        listing (bool): the line lists rather than looks one up.
    """
    named = fl.as_str("file")
    if named is not None:
        data = await read_optional(
            require_vfs(ctx), start_point(fl).join(named)
        )
        if data is None and listing:
            raise _missing_file(named)
        return _parsed(
            ConfigFile.from_file(BytesIO(data or b"")),
            SCOPE_COMMAND,
            f"file:{named}",
        )
    if fl.as_bool("global"):
        return [
            variable
            for source, cfg in await global_sources(ctx, listing)
            for variable in _parsed(cfg, SCOPE_GLOBAL, f"file:{source}")
        ]
    if fl.as_bool("system"):
        return await _system_variables(ctx, listing)
    location = await inside(ctx, fl)
    for scope in ("local", "worktree"):
        if fl.as_bool(scope):
            if location is None:
                raise GitError(
                    f"--{scope} can only be used inside a git repository"
                )
            return await _local_variables(ctx, fl, location)
    rows = await _system_variables(ctx, False)
    if (ctx.env or {}).get("HOME") or (ctx.env or {}).get("GIT_CONFIG_GLOBAL"):
        for source, cfg in await global_sources(ctx, False):
            rows.extend(_parsed(cfg, SCOPE_GLOBAL, f"file:{source}"))
    if location is not None:
        rows.extend(await _local_variables(ctx, fl, location))
    return rows + _command_variables(ctx)


def _value_kind(fl: FlagView) -> str | None:
    """The one value type the line asks for, None for the raw text.

    Args:
        fl (FlagView): parsed flags.

    Raises:
        ConfigUsageError: the line names two.
        GitError: a type git has and mirage does not, or none git has.
    """
    named = [
        (flag.replace("_", "-"), flag)
        for flag in ("bool", "int", "bool_or_int", "path")
        if fl.as_bool(flag)
    ]
    kinds = [kind for kind, _ in named]
    typed = fl.as_str("type")
    if typed is not None:
        kinds.append(typed)
    if len(kinds) > 1:
        raise ConfigUsageError("only one type at a time")
    if not kinds:
        return None
    if kinds[0] in OTHER_VALUE_KINDS:
        raise GitError(f"unsupported --type argument, {kinds[0]}")
    if kinds[0] not in VALUE_KINDS:
        raise GitError(f"unrecognized --type argument, {kinds[0]}")
    return kinds[0]


def _typed_value(
    value: str | None, kind: str | None, name: str, env: dict[str, str]
) -> str | None:
    """A value as the requested type prints it.

    Args:
        value (str | None): the raw value, None for a bare name.
        kind (str | None): the requested type.
        name (str): the variable, for the refusal.
        env (dict[str, str]): the session environment, for ``~``.
    """
    if kind is None:
        return value
    raw = (value or "").encode("utf-8", "surrogateescape")
    if kind == "path":
        if value is not None and value.startswith("~/"):
            return posixpath.join(env.get("HOME", ""), value[2:])
        return value
    if kind == "int":
        return str(config_int(raw, value or "", name, WIDE_INT_BITS))
    if kind == "bool-or-int":
        if value is None:
            return "true"
        try:
            return str(config_int(raw, value, name))
        except BadNumericConfigError:
            decided = maybe_bool(raw)
            if decided is None:
                raise
            return "true" if decided else "false"
    answer = True if value is None else maybe_bool(raw)
    if answer is None:
        raise BadConfigValueError(value or "", name)
    return "true" if answer else "false"


def _query_of(fl: FlagView, words: list[str]) -> tuple[Query, int, int]:
    """Read the action a line names, popping a subcommand word off it.

    Args:
        fl (FlagView): parsed flags.
        words (list[str]): the operands, without a subcommand on return.

    Returns:
        tuple[Query, int, int]: the query and how few and how many
            operands it takes.
    """
    if words[:1] == ["list"]:
        words.pop(0)
        return Query(listing=True), 0, 0
    if words[:1] == ["get"]:
        words.pop(0)
        return (
            Query(
                regexp=fl.as_bool("regexp"),
                every=fl.as_bool("all"),
                names=fl.as_bool("show_names"),
            ),
            1,
            1,
        )
    if fl.as_bool("list"):
        return Query(listing=True), 0, 0
    if fl.as_bool("get_regexp"):
        return Query(regexp=True, every=True, names=True), 1, 2
    if fl.as_bool("get_all"):
        return Query(every=True), 1, 2
    return Query(), 1, 2


def _usage_of(fewest: int, most: int) -> str:
    if fewest == most:
        return f"wrong number of arguments, should be {fewest}"
    return f"wrong number of arguments, should be from {fewest} to {most}"


async def _every(_value: str | None) -> bool:
    return True


def _value_test(
    pattern: str | None, fixed: bool, utf8: bool
) -> Callable[[str | None], Awaitable[bool]]:
    """The test a value pattern puts each value to.

    ``!`` in front negates a pattern, and ``--fixed-value`` compares
    the whole value instead.

    Args:
        pattern (str | None): the pattern, None for every value.
        fixed (bool): compare literally.
        utf8 (bool): match characters under a UTF-8 locale.
    """

    if pattern is None:
        return _every

    async def equal(value: str | None) -> bool:
        return value == pattern

    if fixed:
        return equal
    negated = pattern.startswith("!")
    body = pattern[1:] if negated else pattern
    compiled = posix_regex(byte_view(body, utf8), True, utf8=utf8)

    async def matches(value: str | None) -> bool:
        found = await compiled.search(byte_view(value or "", utf8)) is not None
        return found != negated

    return matches


async def config(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Read configuration: ``--list``, ``--get`` and their subcommands.

    Writes stay refused. Reading goes through the same scopes git has,
    and a default read takes every file and then the command line, so
    the last value wins across all of them.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the name and value pattern.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    words = list(texts)
    action_named = any(
        fl.as_bool(flag) for flag in ("list", "get", "get_all", "get_regexp")
    )
    if not action_named and words[:1] and words[0] in WRITING_SUBCOMMANDS:
        return _read_only()
    if not action_named and words[:1] not in (["list"], ["get"]):
        if not words and fl.as_str("default") is None:
            raise ConfigUsageError("no action specified")
        if len(words) > 1:
            return _read_only()
    query, fewest, most = _query_of(fl, words)
    if not fewest <= len(words) <= most:
        raise ConfigUsageError(_usage_of(fewest, most))
    if (
        sum(
            (
                fl.as_bool("global"),
                fl.as_bool("system"),
                fl.as_bool("local"),
                fl.as_bool("worktree"),
                fl.as_str("file") is not None,
            )
        )
        > 1
    ):
        raise ConfigUsageError("only one config file at a time")
    kind = _value_kind(fl)
    key = words[0] if words else ""
    utf8 = utf8_locale(ctx.env)
    wanted = None
    pattern = None
    if query.regexp:
        try:
            pattern = posix_regex(
                byte_view(config_key(key), utf8), True, utf8=utf8
            )
        except RegexError:
            return _regex_refused(f"error: invalid key pattern: {key}\n")
    elif not query.listing:
        wanted = parse_config_key(key)
    filter_text = fl.as_str("value") if words[1:] == [] else words[1]
    try:
        accepted = _value_test(filter_text, fl.as_bool("fixed_value"), utf8)
    except RegexError:
        return _regex_refused(f"error: invalid pattern: {filter_text}\n")
    variables = await _variables_of(ctx, fl, query.listing)
    rows: list[Variable] = []
    for variable in variables:
        if query.listing or (
            await pattern.search(byte_view(variable.name, utf8)) is not None
            if pattern is not None
            else variable.name == wanted
        ):
            if await accepted(variable.value):
                rows.append(variable)
    if not query.listing and not query.every:
        rows = rows[-1:]
    env = dict(ctx.env or {})
    default = fl.as_str("default")
    if not rows and default is not None and not query.listing:
        rows = [Variable("", "", wanted or key, default)]
    nul = fl.as_bool("null")
    end = "\0" if nul else "\n"
    between = "\0" if nul else "\t"
    origin = fl.as_bool("show_origin")
    scope = fl.as_bool("show_scope")
    only_names = fl.as_bool("name_only")
    out: list[str] = []
    for row in rows:
        shown = _typed_value(row.value, kind, row.name, env)
        head = (f"{row.scope}{between}" if scope and row.scope else "") + (
            f"{row.origin}{between}" if origin and row.origin else ""
        )
        if (query.listing or query.names) and only_names:
            out.append(f"{head}{row.name}{end}")
        elif query.listing or query.names:
            mark = "\n" if nul else "=" if query.listing else " "
            out.append(
                head
                + (
                    row.name + end
                    if shown is None
                    else f"{row.name}{mark}{shown}{end}"
                )
            )
        else:
            out.append(f"{head}{shown or ''}{end}")
    return encode_text("".join(out)), IOResult(
        exit_code=0 if rows or query.listing else 1
    )


def _regex_refused(message: str) -> tuple[ByteSource | None, IOResult]:
    return None, IOResult(
        exit_code=INVALID_REGEX_EXIT, stderr=encode_text(message)
    )


def _read_only() -> tuple[ByteSource | None, IOResult]:
    return None, IOResult(
        exit_code=1,
        stderr=b"error: git config is read-only in Mirage; "
        b"writes are not supported\n",
    )
