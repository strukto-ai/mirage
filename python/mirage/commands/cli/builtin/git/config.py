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

import logging
import posixpath
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from io import BytesIO

from dulwich.config import ConfigFile

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.errors import (
    FATAL_EXIT,
    BadConfigValueError,
    BadNumericConfigError,
    ConfigKeyError,
    ConfigUsageError,
    GitError,
    UsageError,
)
from mirage.commands.cli.builtin.git.io import (
    exists,
    read_optional,
    remove_file,
    stat_of,
)
from mirage.commands.cli.builtin.git.session import inside
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    WIDE_INT_BITS,
    command_line_config,
    config_int,
    config_value,
    maybe_bool,
    parse_config_key,
    require_vfs,
    start_point,
)
from mirage.commands.cli.refusal import git_option_refusal
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandSpec
from mirage.errors.fs import strerror_of
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import RegexError
from mirage.rs.regex import posix_regex
from mirage.shell.bytes import byte_view, encode_text, utf8_locale
from mirage.types import FileType, PathSpec
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)

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
READING_ACTIONS = ("list", "get", "get_all", "get_regexp")
WRITING_ACTIONS = ("add", "unset")
NOTHING_TO_CHANGE_EXIT = 5
WRITE_KEY_EXIT = 2
INVALID_FILE_EXIT = 3
LOCK_EXIT = 255
BOM = b"\xef\xbb\xbf"
SECTION_CHARS = frozenset(
    b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-."
)
ESCAPED = b'"\\ntb'
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

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.
        location (RepoLocation): the discovered repository.
    """
    path = location.commondir.join("config")
    data = await read_optional(require_vfs(ctx), path)
    return _parsed(
        ConfigFile.from_file(BytesIO(data or b"")),
        SCOPE_LOCAL,
        f"file:{_local_label(fl, location, path)}",
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


_Block = tuple[bytes, bool]


@dataclass(frozen=True, slots=True)
class _ConfigLine:
    """One line of a config file, as the writer reads it.

    Args:
        start (int): its first physical line.
        end (int): one past its last (a value continued by a backslash
            runs on).
        header (_Block | None): a header's name as a key's stem
            (section lowercased, then the subsection) and whether that
            is the older ``[section.sub]`` spelling, all lowercased.
        noted (bool): a header with a comment after it on its line.
        name (bytes | None): a variable's name, lowercased; beside a
            header when the variable shares its line.
        comment (bool): a comment line.
        header_end (int): where the header ends on its line, when a
            variable shares that line.
    """

    start: int
    end: int
    header: _Block | None = None
    noted: bool = False
    name: bytes | None = None
    comment: bool = False
    header_end: int = 0


def _physical_lines(data: bytes) -> list[bytes]:
    """The file's physical lines, each with its ending; only LF ends one.

    Args:
        data (bytes): the file.
    """
    parts = data.split(b"\n")
    lines = [part + b"\n" for part in parts[:-1]]
    return lines + [parts[-1]] if parts[-1] else lines


def _line_text(line: bytes) -> bytes:
    """A physical line without its ending, LF or CR LF.

    Args:
        line (bytes): the line.
    """
    return line[:-1].removesuffix(b"\r") if line.endswith(b"\n") else line


def _header_at(text: bytes, at: int) -> tuple[_Block, int] | bytes:
    """The header whose ``[`` is at ``text[at]`` and where it ends, or
    the name git read before refusing it.

    Args:
        text (bytes): the line.
        at (int): where the ``[`` is.
    """
    end = at + 1
    while end < len(text) and text[end] in SECTION_CHARS:
        end += 1
    name = text[at + 1 : end].lower()
    if text[end : end + 1] == b"]":
        if not name:
            return name
        return (name, b"." in name), end + 1
    spaced = end
    while text[end : end + 1] in (b" ", b"\t"):
        end += 1
    if not name or end == spaced or text[end : end + 1] != b'"':
        return name
    sub = b""
    end += 1
    while end < len(text) and text[end : end + 1] != b'"':
        if text[end : end + 1] == b"\\":
            end += 1
        sub += text[end : end + 1]
        end += 1
    if text[end + 1 : end + 2] != b"]":
        return name + b"." + sub
    return (name + b"." + sub, False), end + 2


def _value_end(raw: list[bytes], at: int, start: int) -> tuple[int, bool]:
    """Where the value at ``raw[at][start:]`` ends and whether git can
    read it.

    A backslash ending a line runs the value on, unless a comment holds
    it; ``\\"``, ``\\\\``, ``\\n``, ``\\t`` and ``\\b`` are the only
    other escapes, and a quote must close on its line.

    Args:
        raw (list[bytes]): the physical lines.
        at (int): the value's first line.
        start (int): where it starts on that line.

    Returns:
        tuple[int, bool]: one past the last line read (a quote a
        backslash runs past the end of the file counts the line it ran
        on to), and whether git reads the value.
    """
    quoted = False
    while True:
        ended = raw[at].endswith(b"\n")
        text = _line_text(raw[at])
        index = start
        runs_on = False
        while index < len(text):
            char = text[index : index + 1]
            if char == b"\\":
                if index + 1 == len(text):
                    runs_on = True
                    break
                if text[index + 1 : index + 2] not in ESCAPED:
                    return at + 1, False
                index += 2
                continue
            if char == b'"':
                quoted = not quoted
            elif not quoted and char in (b"#", b";"):
                break
            index += 1
        if runs_on and ended and at + 1 < len(raw):
            at, start = at + 1, 0
            continue
        return at + (2 if runs_on and quoted else 1), not quoted


def _skipping(text: bytes, at: int, skipped: bytes) -> int:
    """Where the text from ``at`` resumes past the bytes ``skipped`` holds.

    Args:
        text (bytes): the line.
        at (int): where to start.
        skipped (bytes): the bytes to pass over.
    """
    index = at
    while index < len(text) and text[index] in skipped:
        index += 1
    return index


def _config_lines_of(
    raw: list[bytes], shown: str
) -> list[_ConfigLine] | IOResult:
    """The file's lines as git reads them, or its refusal of the file.

    A header can share its line with a comment or with one variable,
    and a value continued by a backslash takes the lines it runs on. A
    header git cannot read is refused by name; any other line git
    cannot read, by number (pinned against git 2.47.3).

    Args:
        raw (list[bytes]): the physical lines.
        shown (str): the file as git names it.
    """
    out: list[_ConfigLine] = []
    at = 0
    while at < len(raw):
        text = _line_text(raw[at])
        index = _skipping(
            text,
            len(BOM) if at == 0 and text.startswith(BOM) else 0,
            b" \t\r\v\f",
        )
        header: _Block | None = None
        header_end = 0
        while text[index : index + 1] == b"[":
            found = _header_at(text, index)
            if isinstance(found, bytes):
                return IOResult(
                    exit_code=INVALID_FILE_EXIT,
                    stderr=b"error: invalid section name '"
                    + found
                    + b"'\n"
                    + encode_text(f"error: invalid config file {shown}\n"),
                )
            header, header_end = found
            index = _skipping(text, header_end, b" \t")
        rest = text[index:]
        if not rest or rest[:1] in (b"#", b";"):
            out.append(
                _ConfigLine(
                    at,
                    at + 1,
                    header=header,
                    noted=header is not None and bool(rest),
                    comment=header is None and bool(rest),
                )
            )
            at += 1
            continue
        end = index
        while text[end : end + 1].isalnum() or text[end : end + 1] == b"-":
            end += 1
        name = text[index:end].lower()
        after = _skipping(text, end, b" \t")
        finish, readable = at + 1, rest[:1].isalpha()
        if readable and after < len(text):
            readable = text[after : after + 1] == b"="
            if readable:
                finish, readable = _value_end(raw, at, after + 1)
        if not readable:
            return IOResult(
                exit_code=FATAL_EXIT,
                stderr=encode_text(
                    f"fatal: bad config line {finish} in file {shown}\n"
                ),
            )
        out.append(
            _ConfigLine(
                at, finish, header=header, name=name, header_end=header_end
            )
        )
        at = finish
    return out


def _in_block(block: _Block, stem: bytes, placing: bool = False) -> bool:
    """Whether a header opens the block a name lives in.

    git compares the whole stem, so ``[a.b "c"]`` and ``[a "b.c"]`` both
    hold ``a.b.c.x``. A name matches exactly, the older spelling's
    lowercased stem included; placing a new name, that spelling compares
    without case (pinned against git 2.47.3).

    Args:
        block (_Block): the header's block.
        stem (bytes): the name without its variable, section lowercased.
        placing (bool): finding the block a new variable goes in.
    """
    name, caseless = block
    return name == stem or (placing and caseless and name == stem.lower())


def _config_edit(
    data: bytes, key: str, value: str | None, adding: bool, shown: str
) -> bytes | IOResult:
    """The config text with one variable set, added or taken out.

    A set rewrites the one line the variable has, and a new variable
    goes after the last variable of the last block it belongs in, or in
    a new block at the end, spelled as typed. Taking the last variable
    out of a block takes the block too, with the blank lines around it,
    unless a comment is there or the next block is the same one. A file
    git cannot read is left as it is (pinned against git 2.47.3).

    Args:
        data (bytes): the file as it is.
        key (str): the name as typed.
        value (str | None): the value to set or add; None takes it out.
        adding (bool): add a value beside any the variable has.
        shown (str): the file as git names it.

    Returns:
        bytes | IOResult: the new text, or git's refusal.
    """
    section, _, rest = key.partition(".")
    subsection, dot, variable = rest.rpartition(".")
    sub = encode_text(subsection) if dot else None
    stem = section.lower().encode() + (b"." + sub if sub is not None else b"")
    wanted = variable.lower().encode()
    raw = _physical_lines(data)
    lines = _config_lines_of(raw, shown)
    if isinstance(lines, IOResult):
        return lines
    block: _Block | None = None
    owners: list[int] = []
    matches: list[int] = []
    for index, line in enumerate(lines):
        if line.header is not None:
            block = line.header
            if _in_block(block, stem, placing=True):
                owners.append(index)
        if (
            line.name == wanted
            and block is not None
            and _in_block(block, stem)
        ):
            matches.append(index)
    if value is None:
        if not matches:
            return IOResult(exit_code=NOTHING_TO_CHANGE_EXIT)
        if len(matches) > 1:
            return IOResult(
                exit_code=NOTHING_TO_CHANGE_EXIT,
                stderr=encode_text(f"warning: {key} has multiple values\n"),
            )
        return b"".join(_without(raw, lines, matches[0]))
    entry = encode_text(f"\t{variable} = {config_value(value)}\n")
    if matches and not adding:
        if len(matches) > 1:
            return IOResult(
                exit_code=NOTHING_TO_CHANGE_EXIT,
                stderr=encode_text(
                    f"warning: {key} has multiple values\n"
                    "error: cannot overwrite multiple values with a "
                    "single value\n"
                    f"       Use a regexp, --add or --replace-all to change "
                    f"{key}.\n"
                ),
            )
        found = lines[matches[0]]
        head = (
            [raw[found.start][: found.header_end] + b"\n"]
            if found.header is not None
            else []
        )
        return b"".join(raw[: found.start] + head + [entry] + raw[found.end :])
    if owners:
        after = lines[owners[-1]].end
        for line in lines[owners[-1] + 1 :]:
            if line.header is not None:
                break
            if line.name is not None:
                after = line.end
        if not raw[after - 1].endswith(b"\n"):
            entry = b"\n" + entry
        return b"".join(raw[:after] + [entry] + raw[after:])
    opening = encode_text(
        f"[{section}]\n"
        if sub is None
        else '[{} "{}"]\n'.format(
            section, subsection.replace("\\", "\\\\").replace('"', '\\"')
        )
    )
    if data == BOM:
        return opening + entry + data
    text = data if not data or data.endswith(b"\n") else data + b"\n"
    return text + opening + entry


def _without(
    raw: list[bytes], lines: list[_ConfigLine], index: int
) -> list[bytes]:
    """The physical lines with one variable out, and its block if that
    leaves it empty.

    A variable beside its header leaves the header alone on its line. A
    block taken from the top of a file that opens with a byte order mark
    leaves the mark and a line end.

    Args:
        raw (list[bytes]): the physical lines.
        lines (list[_ConfigLine]): the lines as the writer reads them.
        index (int): the variable's line.
    """
    found = lines[index]
    head: int | None = index
    if found.header is not None:
        kept = (
            raw[: found.start]
            + [raw[found.start][: found.header_end] + b"\n"]
            + raw[found.end :]
        )
    else:
        head = max(
            (at for at in range(index) if lines[at].header is not None),
            default=None,
        )
        kept = raw[: found.start] + raw[found.end :]
    if head is None or lines[head].noted:
        return kept
    after = next(
        (
            at
            for at in range(head + 1, len(lines))
            if lines[at].header is not None
        ),
        len(lines),
    )
    inner = [lines[at] for at in range(head + 1, after) if at != index]
    before = next(
        (
            lines[at]
            for at in range(head - 1, -1, -1)
            if lines[at].header is not None
            or lines[at].name is not None
            or lines[at].comment
        ),
        None,
    )
    if (
        any(line.name is not None or line.comment for line in inner)
        or (head != index and lines[head].name is not None)
        or (before is not None and before.comment)
        or (after < len(lines) and lines[after].header == lines[head].header)
    ):
        return kept
    first = before.end if before is not None else 0
    last = lines[after].start if after < len(lines) else len(raw)
    mark = [BOM + b"\n"] if first == 0 and raw[0].startswith(BOM) else []
    return raw[:first] + mark + raw[last:]


def _local_label(fl: FlagView, location: RepoLocation, path: PathSpec) -> str:
    """The repository's own config as git names it.

    git names it from the top of the work tree it moved to, so an
    ordinary checkout says ``.git/config`` from anywhere inside it.

    Args:
        fl (FlagView): parsed flags.
        location (RepoLocation): the discovered repository.
        path (PathSpec): the file.
    """
    ordinary = (
        location.commondir.virtual == location.worktree.virtual + "/.git"
    )
    start = start_point(fl).virtual
    within = start == location.worktree.virtual or start.startswith(
        location.worktree.virtual + "/"
    )
    return ".git/config" if ordinary and within else path.raw_path


async def _config_path(ctx: Context, fl: FlagView) -> tuple[PathSpec, str]:
    """The one file a write changes, as git picks it, and its name as
    git says it.

    ``--global`` writes ``~/.gitconfig``, or the XDG file when only that
    one exists.

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.

    Raises:
        GitError: ``--file -``, which names standard input; no
            ``$HOME`` for ``--global``; or no repository for the
            repository's own file.
    """
    named = fl.as_str("file")
    if named == "-":
        raise GitError(
            "writing to stdin is not supported"
            if await inside(ctx, fl) is not None
            else "not in a git directory"
        )
    if named is not None:
        return start_point(fl).join(named), named
    env = ctx.env or {}
    if fl.as_bool("global"):
        override = env.get("GIT_CONFIG_GLOBAL")
        if override is not None:
            return PathSpec.from_str_path(override, cwd="/"), override
        home = env.get("HOME", "")
        if not home:
            raise GitError("$HOME not set")
        target = posixpath.join(home, ".gitconfig")
        xdg = posixpath.join(
            env.get("XDG_CONFIG_HOME") or posixpath.join(home, ".config"),
            "git/config",
        )
        vfs = require_vfs(ctx)
        shown = (
            xdg
            if await read_optional(
                vfs, PathSpec.from_str_path(target, cwd="/")
            )
            is None
            and await read_optional(vfs, PathSpec.from_str_path(xdg, cwd="/"))
            is not None
            else target
        )
        return PathSpec.from_str_path(shown, cwd="/"), shown
    if fl.as_bool("system"):
        shown = env.get("GIT_CONFIG_SYSTEM", SYSTEM_CONFIG)
        return PathSpec.from_str_path(shown, cwd="/"), shown
    location = await inside(ctx, fl)
    if location is None:
        raise GitError("not in a git directory")
    path = location.commondir.join("config")
    return path, _local_label(fl, location, path)


async def _hold_lock(
    vfs: Files, lock: PathSpec, shown: str
) -> IOResult | None:
    """Take a config file's lock and hold it, or git's refusal.

    git refuses when the file's folder is missing, when the lock is
    already there (another writer holds it) or when it cannot be made,
    on a read-only mount among others. The look and the create are two
    ops, since the dispatcher has no exclusive create.

    Args:
        vfs (Files): the session's files.
        lock (PathSpec): ``<file>.lock``.
        shown (str): the file as git names it.
    """
    folder = await stat_of(vfs, lock.parent)
    if folder is None:
        reason = posix_phrase(FsCondition.ENOENT)
    elif folder.type is not FileType.DIRECTORY:
        reason = posix_phrase(FsCondition.ENOTDIR)
    elif await exists(vfs, lock):
        reason = posix_phrase(FsCondition.EEXIST)
    else:
        try:
            await vfs.write(lock, b"")
            return None
        except OSError as exc:
            logger.debug("config lock %s refused: %s", lock.virtual, exc)
            reason = strerror_of(exc)
    return IOResult(
        exit_code=LOCK_EXIT,
        stderr=encode_text(
            f"error: could not lock config file {shown}: {reason}\n"
        ),
    )


def _one_file(fl: FlagView) -> None:
    """Refuse a line naming more than one config file.

    Args:
        fl (FlagView): parsed flags.

    Raises:
        ConfigUsageError: two scopes, or a scope and ``--file``.
    """
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


def _unknown_option(ctx: Context, given: list[str]) -> None:
    """Refuse options git does not know on this form of write, naming
    the first one on the line: ``--all`` and ``--value`` belong to
    ``set`` and ``unset``, and the reading options to the reads.

    Args:
        ctx (Context): the line's context.
        given (list[str]): the long spellings the line carries.

    Raises:
        UsageError: any is on the line.
    """
    if not given:
        return
    argv = ctx.argv
    tail = argv[argv.index("config") + 1 :] if "config" in argv else argv
    word = next(
        (
            text
            for text in tail
            if any(
                text == name or text.startswith(name + "=") for name in given
            )
        ),
        given[0],
    )
    spec = ctx.spec or CommandSpec()
    raise UsageError(*git_option_refusal(word, spec.name, spec))


async def _config_write(
    ctx: Context, fl: FlagView, words: list[str]
) -> tuple[ByteSource | None, IOResult] | None:
    """A set, ``--add`` or unset, or None when the line reads.

    ``set``, ``unset``, ``--add``, ``--unset`` and the two-word set
    change one file, holding its lock from the read to the write. What
    else writes (a value pattern, ``--all``, a type, ``--replace-all``,
    ``--worktree``, the section subcommands, ``edit``) stays refused.

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.
        words (list[str]): the operands.
    """
    actions = fl.typed_order(*READING_ACTIONS, *WRITING_ACTIONS)
    writes = [name for name in actions if name in WRITING_ACTIONS]
    if writes and len(actions) > 1:
        later, earlier = (
            actions[-1],
            next(name for name in actions if name != actions[-1]),
        )
        raise ConfigUsageError(
            f"options '--{later.replace('_', '-')}' and "
            f"'--{earlier.replace('_', '-')}' cannot be used together"
        )
    if actions and not writes:
        return None
    subcommand = words[0] if not actions and words else None
    if subcommand in ("list", "get"):
        return None
    if subcommand in ("set", "unset"):
        _unknown_option(
            ctx,
            [
                name
                for name, on in (
                    ("--default", fl.as_str("default") is not None),
                    ("--name-only", fl.as_bool("name_only")),
                    ("--show-origin", fl.as_bool("show_origin")),
                )
                if on
            ],
        )
        words = words[1:]
        count = 2 if subcommand == "set" else 1
        if len(words) != count:
            raise ConfigUsageError(_usage_of(count, count))
        if fl.as_bool("all") or fl.as_str("value") is not None:
            return _read_only()
        if fl.as_bool("fixed_value"):
            raise GitError(
                "--fixed-value only applies with --value=<pattern>"
                if subcommand == "set"
                else "--fixed-value only applies with 'value-pattern'"
            )
        value = words[1] if subcommand == "set" else None
    elif subcommand in WRITING_SUBCOMMANDS:
        return _read_only()
    elif not writes and len(words) < 2:
        return None
    else:
        _unknown_option(
            ctx,
            [
                name
                for name, on in (
                    ("--all", fl.as_bool("all")),
                    ("--value", fl.as_str("value") is not None),
                )
                if on
            ],
        )
        for wrong, message in (
            (
                fl.as_str("default") is not None,
                "--default is only applicable to --get",
            ),
            (
                fl.as_bool("name_only"),
                "--name-only is only applicable to --list or --get-regexp",
            ),
            (
                fl.as_bool("show_origin"),
                "--show-origin is only applicable to --get, --get-all, "
                "--get-regexp, and --list",
            ),
        ):
            if wrong:
                raise ConfigUsageError(message)
        if writes == ["add"]:
            if len(words) != 2:
                raise ConfigUsageError(_usage_of(2, 2))
            value = words[1]
        elif writes == ["unset"]:
            if not 1 <= len(words) <= 2:
                raise ConfigUsageError(_usage_of(1, 2))
            if len(words) == 2:
                return _read_only()
            value = None
        elif len(words) == 2:
            value = words[1]
        else:
            return _read_only()
        if fl.as_bool("fixed_value"):
            raise ConfigUsageError(
                "--fixed-value only applies with 'value-pattern'"
            )
    _one_file(fl)
    if _value_kind(fl) is not None or fl.as_bool("worktree"):
        return _read_only()
    key = words[0]
    try:
        parse_config_key(key)
    except ConfigKeyError as refusal:
        if not str(refusal).startswith("key does not contain"):
            raise
        return None, IOResult(
            exit_code=WRITE_KEY_EXIT,
            stderr=encode_text(f"error: {refusal}\n"),
        )
    path, shown = await _config_path(ctx, fl)
    vfs = require_vfs(ctx)
    lock = PathSpec.from_str_path(
        f"{path.dotted or path.virtual}.lock", cwd="/"
    )
    refused = await _hold_lock(vfs, lock, shown)
    if refused is not None:
        return None, refused
    try:
        data = await read_optional(vfs, path)
        if data is None and value is None:
            return None, IOResult(exit_code=NOTHING_TO_CHANGE_EXIT)
        edited = _config_edit(
            data or b"", key, value, writes == ["add"], shown
        )
        if isinstance(edited, IOResult):
            return None, edited
        await vfs.write(path, edited)
    finally:
        await remove_file(vfs, lock)
    return None, IOResult()


async def config(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Read configuration, or set, add and unset one variable.

    Reading goes through the same scopes git has, and a default read
    takes every file and then the command line, so the last value wins
    across all of them. A write changes the one file its scope names.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the name and value pattern.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    words = list(texts)
    written = await _config_write(ctx, fl, words)
    if written is not None:
        return written
    action_named = any(fl.as_bool(flag) for flag in READING_ACTIONS)
    if (
        not action_named
        and words[:1] not in (["list"], ["get"])
        and not words
        and fl.as_str("default") is None
    ):
        raise ConfigUsageError("no action specified")
    query, fewest, most = _query_of(fl, words)
    if not fewest <= len(words) <= most:
        raise ConfigUsageError(_usage_of(fewest, most))
    _one_file(fl)
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
