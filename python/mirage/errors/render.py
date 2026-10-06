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

from mirage.errors.constants import OPERAND_CONDITIONS, READ_FAILURES
from mirage.errors.fs import error_path, fs_error, fs_strerror, virtual_of
from mirage.errors.posix import posix_phrase
from mirage.types import PathSpec
from mirage.utils.path import drop_trailing_segments, respell_one
from mirage.utils.quote import (
    quotes_operands,
    shell_quote,
    shell_quote_always,
)


def operand_spelling(path: str, operand: PathSpec) -> str:
    """Re-spell a reported path the way its operand was typed.

    Backends name paths in virtual space, but a command quotes the operand
    as the user wrote it: ``cd /data && mkdir -p f.txt/sub`` reports
    ``'f.txt'``, not ``'/data/f.txt'``. The path an error names is the
    operand itself, an ancestor of it (``mkdir -p`` blames the component
    of the chain it tripped on), or something under it, so all three are
    rebased onto ``raw_path``. An absolute operand rebases to itself,
    which is why this is a no-op for most invocations.

    Args:
        path (str): The virtual path the error named.
        operand (PathSpec): The operand the command was given.
    """
    raw, virtual = operand.raw_path, operand.virtual
    if raw == virtual:
        return path
    if path == virtual:
        return raw
    base = virtual.rstrip("/")
    if path.startswith(base + "/"):
        return respell_one(path, virtual, raw)
    trimmed = path.rstrip("/")
    if base.startswith(trimmed + "/"):
        depth = len(_segments(base)) - len(_segments(trimmed))
        return drop_trailing_segments(raw, depth)
    return path


def _segments(path: str) -> list[str]:
    return [part for part in path.split("/") if part]


_CANNOT_OPEN = "cannot open {quoted} for reading: {strerror}"


# How a failed operand is worded by the commands that name the step that
# failed instead of printing ``<cmd>: <name>: <strerror>``. An entry is
# (opening, reading): the line for a name the command could not open, and
# for one it opened that then refused the read (READ_FAILURES). None keeps
# the plain line for that step, which is also the choice wherever the
# reference line drops the name (``base64: read error``, ``fmt: read
# error``): mirage words a step that way only while it still says which
# operand failed. ``{quoted}`` is the name always quoted, ``{shown}``
# quoted only when it needs it, ``{bare}`` as typed. Measured on
# debian:stable-slim, a directory read on tmpfs: overlayfs answers a
# directory's read with EINVAL, so a tac there says ``read error:
# Invalid argument``.
FAILURE_WORDING: dict[str, tuple[str | None, str | None]] = {
    "csplit": (_CANNOT_OPEN, None),
    "du": ("cannot access {quoted}: {strerror}", None),
    "find": ("{quoted}: {strerror}", "{quoted}: {strerror}"),
    "fmt": (_CANNOT_OPEN, None),
    "head": (_CANNOT_OPEN, "error reading {quoted}: {strerror}"),
    "ls": ("cannot access {quoted}: {strerror}", None),
    "mkdir": (
        "cannot create directory {quoted}: {strerror}",
        "cannot create directory {quoted}: {strerror}",
    ),
    "rev": ("cannot open {bare}: {strerror}", None),
    "rm": (
        "cannot remove {quoted}: {strerror}",
        "cannot remove {quoted}: {strerror}",
    ),
    "rmdir": (
        "failed to remove {quoted}: {strerror}",
        "failed to remove {quoted}: {strerror}",
    ),
    "sed": (
        "can't read {bare}: {strerror}",
        "read error on {bare}: {strerror}",
    ),
    "split": (_CANNOT_OPEN, None),
    "stat": (
        "cannot statx {quoted}: {strerror}",
        "cannot statx {quoted}: {strerror}",
    ),
    "tac": (
        "failed to open {quoted} for reading: {strerror}",
        "{shown}: read error: {strerror}",
    ),
    "tail": (_CANNOT_OPEN, "error reading {quoted}: {strerror}"),
    "touch": (
        "cannot touch {quoted}: {strerror}",
        "cannot touch {quoted}: {strerror}",
    ),
    "truncate": (
        "cannot open {quoted} for writing: {strerror}",
        "cannot open {quoted} for writing: {strerror}",
    ),
    "tsort": (None, "{shown}: read error: {strerror}"),
    "uniq": (None, "error reading {quoted}: {strerror}"),
}


# wc and du vet every name the way their --files0-from reader does, and
# refuse an empty one in these words before any open could answer ENOENT
# for it.
ZERO_LENGTH_NAME = "invalid zero-length file name"


_VETS_EMPTY_NAMES = frozenset({"du", "wc"})


def _step_wording(cmd_name: str, label: str, exc: BaseException) -> str | None:
    """The command's own template for this failure, None for the plain
    line: no entry, no template for the step, or standard input, whose
    ``-`` line is the one a command prints when it closes a stdin it could
    not read.

    Args:
        cmd_name (str): Command name.
        label (str): The operand as reported.
        exc (BaseException): The filesystem error.
    """
    wording = FAILURE_WORDING.get(cmd_name)
    if wording is None or label == "-":
        return None
    return wording[1] if isinstance(exc, READ_FAILURES) else wording[0]


def fs_error_line(
    cmd_name: str, path: str | PathSpec, exc: BaseException
) -> str:
    """The stderr line for one failed path operand.

    Produces ``<cmd>: <path>: <strerror>``, byte-identical with the
    TypeScript formatter. ``path`` is the operand itself when the caller
    knows it (read-family commands that keep processing remaining operands
    after one fails, reported as typed via ``raw_path``), or an
    already-resolved label string. A command in ``SHELL_QUOTED_COMMANDS``
    reports the operand shell-quoted when it needs it (``'*.txt'``);
    every other command reports it bare. A command in
    ``FAILURE_WORDING`` says which step failed instead.

    Args:
        cmd_name (str): Command name for the ``<cmd>:`` prefix.
        path (object): The failed operand; ``raw_path`` (or ``virtual``) is
            the reported spelling, a plain string is used verbatim.
        exc (BaseException): The filesystem error.
    """
    raw = getattr(path, "raw_path", None)
    label = raw if raw is not None else virtual_of(path)
    if label == "" and cmd_name in _VETS_EMPTY_NAMES:
        return f"{cmd_name}: {ZERO_LENGTH_NAME}\n"
    strerror = fs_strerror(exc)
    template = _step_wording(cmd_name, label, exc)
    if template is not None and strerror is not None:
        line = template.format(
            quoted=shell_quote_always(label),
            shown=shell_quote(label),
            bare=label,
            strerror=strerror,
        )
        return f"{cmd_name}: {line}\n"
    if quotes_operands(cmd_name):
        label = shell_quote(label)
    if strerror is not None:
        return f"{cmd_name}: {label}: {strerror}\n"
    return f"{cmd_name}: {label}\n"


def revoice_fs_error_line(
    line: str, from_cmd: str, cmd_name: str, operand: str | PathSpec
) -> str:
    """Re-say another command's failed-operand line in `cmd_name`'s voice.

    A command that reads its operands through another one (the
    cross-mount stream strategy fetches each with ``cat``) holds that
    command's rendered line, not the error. When the line is the fetch
    command's own ``fs_error_line`` for ``operand``, it is rendered again
    from the strerror it names, so the prefix, the quoting and the step
    wording are all the real command's; any other line only has its
    prefix swapped. Mirrors TS ``revoiceFsErrorLine``.

    Args:
        line (str): one stderr line, without its newline.
        from_cmd (str): the command that printed it.
        cmd_name (str): the command to say it as.
        operand (str | PathSpec): the operand the fetch was for.
    """
    prefix = f"{from_cmd}: "
    if not line.startswith(prefix):
        return line
    strerror = line.rsplit(": ", 1)[-1]
    for condition in OPERAND_CONDITIONS:
        if posix_phrase(condition) != strerror:
            continue
        exc = fs_error(operand, condition)
        if fs_error_line(from_cmd, operand, exc) == f"{line}\n":
            return fs_error_line(cmd_name, operand, exc).removesuffix("\n")
        break
    return f"{cmd_name}: {line[len(prefix) :]}"


def format_fs_error(
    cmd_name: str, exc: Exception, paths: list[PathSpec] | None = None
) -> bytes:
    """Format a thrown command error as a stderr line.

    The chokepoint variant of ``fs_error_line`` for callers that only hold
    the exception, byte-identical with the TypeScript ``formatFsError``. A
    recognized filesystem error becomes ``<cmd>: <path>: <strerror>`` (the
    path is recovered from ``exc.filename`` when set, else ``str(exc)``;
    backends raise with the resolved absolute path, and ``paths`` rewrites it
    to the as-typed ``PathSpec.raw_path`` so a relative argument is reported
    as typed). Any other exception becomes the generic ``<cmd>: <message>``
    line, the ``prog: message`` prefix the TypeScript executor uses too. A
    message that already carries the ``<cmd>: `` prefix (many generic
    commands raise a fully formatted string, e.g. ``uniq: invalid
    count``) is emitted verbatim so the prefix is not doubled.

    Args:
        cmd_name (str): Command name for the ``<cmd>:`` prefix.
        exc (Exception): The thrown error.
        paths (list[PathSpec] | None): Command operands, used to map the
            resolved path back to the as-typed form.
    """
    if fs_strerror(exc) is None:
        message = str(exc)
        if not message.startswith(f"{cmd_name}: "):
            message = f"{cmd_name}: {message}"
        return f"{message}\n".encode("utf-8", "surrogateescape")
    path = error_path(exc)
    if paths:
        for p in paths:
            if p.virtual == path:
                path = p.raw_path
                break
    return fs_error_line(cmd_name, path, exc).encode(
        "utf-8", "surrogateescape"
    )
