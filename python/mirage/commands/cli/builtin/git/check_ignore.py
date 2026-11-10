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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.cli.builtin.git.changes import staged_entries
from mirage.commands.cli.builtin.git.errors import (
    EmptyPathspecError,
    GitError,
    UsageError,
)
from mirage.commands.cli.builtin.git.ignore import (
    GITIGNORE,
    IgnoreFile,
    Rule,
    last_match,
    load_ignore_files,
    parse_rules,
)
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.io import is_directory, read_optional
from mirage.commands.cli.builtin.git.pathspec import repo_relative
from mirage.commands.cli.builtin.git.render import quote_path
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import IndexState, RepoLocation
from mirage.commands.cli.builtin.git.util import (
    fatal,
    lone_help,
    option_operand,
    require_vfs,
    start_point,
    verb_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import decode_text, encode_text
from mirage.types import PathSpec
from mirage.workspace.files import Files

QUOTE = ord('"')
BACKSLASH = ord("\\")
OCTAL_DIGITS = 3
OCTAL_BASE = 8
BYTE_LIMIT = 256
ESCAPES = {
    ord("a"): 7,
    ord("b"): 8,
    ord("f"): 12,
    ord("n"): 10,
    ord("r"): 13,
    ord("t"): 9,
    ord("v"): 11,
    BACKSLASH: BACKSLASH,
    QUOTE: QUOTE,
}
BADLY_QUOTED = "line is badly quoted"
NO_MATCH = ("", "", "")


def _unquoted(line: bytes) -> bytes:
    """One C-quoted line, read up to its closing quote.

    Args:
        line (bytes): the line, opening quote included.

    Raises:
        GitError: the quoting is broken or never closes.
    """
    out = bytearray()
    at = 1
    while at < len(line):
        byte = line[at]
        if byte == QUOTE:
            return bytes(out)
        if byte != BACKSLASH:
            out.append(byte)
            at += 1
            continue
        code = line[at + 1 : at + 2]
        if code and code[0] in ESCAPES:
            out.append(ESCAPES[code[0]])
            at += 2
            continue
        digits = line[at + 1 : at + 1 + OCTAL_DIGITS]
        try:
            value = int(digits, OCTAL_BASE)
        except ValueError as exc:
            raise GitError(BADLY_QUOTED) from exc
        if len(digits) != OCTAL_DIGITS or value >= BYTE_LIMIT:
            raise GitError(BADLY_QUOTED)
        out.append(value)
        at += 1 + OCTAL_DIGITS
    raise GitError(BADLY_QUOTED)


def _refuse_options(fl: FlagView, texts: list[str]) -> None:
    """Refuse an option set git refuses, in the order git checks them.

    Args:
        fl (FlagView): parsed flags.
        texts (list[str]): the path operands.

    Raises:
        GitError: the options cannot go together.
    """
    reading = fl.as_bool("stdin")
    quiet = fl.as_bool("quiet")
    verbose = fl.as_bool("verbose")
    if reading and texts:
        raise GitError("cannot specify pathnames with --stdin")
    if fl.as_bool("z") and not reading:
        raise GitError("-z only makes sense with --stdin")
    if not reading and not texts:
        raise GitError("no path specified")
    if quiet and len(texts) > 1:
        raise GitError("--quiet is only valid with a single pathname")
    if quiet and verbose:
        raise GitError("cannot have both --quiet and --verbose")
    if fl.as_bool("non_matching") and not verbose:
        raise GitError("--non-matching is only valid with --verbose")


def _path_of(location: RepoLocation, start: str, word: str) -> str:
    """A typed path as a repository-relative one.

    Args:
        location (RepoLocation): the discovered repository.
        start (str): absolute virtual path git is running in.
        word (str): the path as typed.

    Raises:
        EmptyPathspecError: the word is empty.
    """
    if not word:
        raise EmptyPathspecError()
    return repo_relative(location, start, word)


def _tracked(state: IndexState) -> set[str]:
    """Every indexed path and every directory above one.

    Args:
        state (IndexState): the parsed index.
    """
    seen: set[str] = set()
    for raw in (*staged_entries(state), *state.conflicts):
        name = decode_text(raw)
        while name and name not in seen:
            seen.add(name)
            name = posixpath.dirname(name)
    return seen


async def _files_of(
    vfs: Files,
    location: RepoLocation,
    known: dict[str, list[IgnoreFile]],
    directory: str,
) -> list[IgnoreFile]:
    """The ignore files governing one directory, innermost last.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        known (dict[str, list[IgnoreFile]]): what has been read so far.
        directory (str): repository-relative directory.
    """
    held = known.get(directory)
    if held is not None:
        return held
    above = await _files_of(vfs, location, known, posixpath.dirname(directory))
    data = await read_optional(
        vfs, location.worktree.join(directory).join(GITIGNORE)
    )
    files = above
    if data is not None:
        source = f"{directory}/{GITIGNORE}"
        files = [*above, IgnoreFile(directory, source, parse_rules(data))]
    known[directory] = files
    return files


async def _verdict(
    vfs: Files,
    location: RepoLocation,
    known: dict[str, list[IgnoreFile]],
    path: str,
    is_dir: bool,
) -> tuple[IgnoreFile, Rule] | None:
    """The rule that decides a path, walking down from the top.

    A directory an exclude rule catches decides everything below it,
    since git never looks inside to read a line that might re-include
    a child.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        known (dict[str, list[IgnoreFile]]): what has been read so far.
        path (str): repository-relative path.
        is_dir (bool): whether the path names a directory.
    """
    parts = path.split("/")
    for depth in range(1, len(parts)):
        parent = "/".join(parts[:depth])
        files = await _files_of(
            vfs, location, known, posixpath.dirname(parent)
        )
        found = last_match(files, parent, True)
        if found is not None and found[1].pattern.is_exclude:
            return found
    files = await _files_of(vfs, location, known, posixpath.dirname(path))
    return last_match(files, path, is_dir)


def _row(
    word: str,
    fields: tuple[str, str, str],
    zero: bool,
    fully: bool,
    verbose: bool,
) -> bytes:
    """One answer: the path as typed, after its rule under ``-v``.

    Args:
        word (str): the path as typed.
        fields (tuple[str, str, str]): the source, line and pattern.
        zero (bool): separate the fields with NUL.
        fully (bool): the value of ``core.quotepath``.
        verbose (bool): show the fields.
    """
    if zero:
        head = "".join(f"{field}\0" for field in fields) if verbose else ""
        return encode_text(f"{head}{word}\0")
    head = f"{fields[0]}:{fields[1]}:{fields[2]}\t" if verbose else ""
    return encode_text(f"{head}{quote_path(word, False, fully)}\n")


async def check_ignore(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Say which paths the ignore rules cover.

    Operands are checked before any answer; lines read with ``--stdin``
    are checked one at a time, so the answers before a bad line stand.
    Exits 0 when any path was covered and 1 when none was.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the path operands.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    vfs = require_vfs(ctx)
    if option_operand(ctx, texts, lone_help(ctx, texts)) is not None:
        raise UsageError("", verb_usage(ctx))
    _, location = await opened(ctx, fl, work_tree=True)
    _refuse_options(fl, texts)
    start = start_point(fl).virtual
    for word in texts:
        _path_of(location, start, word)
    reading = fl.as_bool("stdin")
    zero = fl.as_bool("z")
    quiet = fl.as_bool("quiet")
    verbose = fl.as_bool("verbose")
    non_matching = fl.as_bool("non_matching")
    fully = await config_bool(vfs, location, b"core", b"quotepath", True)
    tracked = (
        set()
        if fl.as_bool("no_index")
        else _tracked(await read_index(vfs, location.gitdir))
    )
    items = [encode_text(word) for word in texts]
    if reading:
        data = await read_stdin_async(ctx.stdin) or b""
        items = data.split(b"\0" if zero else b"\n")
        if items[-1] == b"":
            items.pop()
    known = {"": await load_ignore_files(vfs, location)}
    out = bytearray()
    covered = False
    try:
        for item in items:
            line = (
                _unquoted(item)
                if reading and not zero and item.startswith(b'"')
                else item
            )
            word = decode_text(line)
            path = _path_of(location, start, word)
            found = None
            if path and path not in tracked:
                is_dir = word.endswith("/") or await is_directory(
                    vfs, location.worktree.join(path)
                )
                found = await _verdict(vfs, location, known, path, is_dir)
            if found is None:
                if verbose and non_matching:
                    out += _row(word, NO_MATCH, zero, fully, verbose)
                continue
            source, rule = found
            if not verbose and not rule.pattern.is_exclude:
                continue
            covered = True
            if not quiet:
                fields = (source.source, str(rule.line), rule.text)
                out += _row(word, fields, zero, fully, verbose)
    except GitError as exc:
        _, refused = fatal(exc)
        return bytes(out) or None, refused
    return bytes(out) or None, IOResult(exit_code=0 if covered else 1)
