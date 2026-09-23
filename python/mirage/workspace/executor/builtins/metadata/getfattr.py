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

import base64
import re

from mirage.commands.spec import SPECS, parse_command
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.parser import parse_to_kwargs
from mirage.errors import FsCondition, classify
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec, word_text
from mirage.workspace.executor.builtins.metadata.xattr import (
    GETFATTR_USAGE, attr_error, attr_operands, attr_usage_refusal)
from mirage.workspace.executor.builtins.shared import result
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.session import SessionState

_ENCODINGS = ("text", "hex", "base64")
_DEFAULT_MATCH = r"^user\."


def encode_value(value: bytes, encoding: str | None) -> bytes:
    """One value the way getfattr prints it after ``name=``.

    With no ``-e`` the value is text when at most one byte in eight is
    unprintable (a trailing NUL not counted) and base64 otherwise. Text
    escapes NUL, newline and carriage return as octal and ``"`` and
    ``\\`` with a backslash, and passes every other byte through raw;
    a trailing NUL is dropped.

    Args:
        value (bytes): the attribute value.
        encoding (str | None): ``text``, ``hex``, ``base64`` or None.
    """
    body = value[:-1] if value.endswith(b"\0") else value
    if encoding is None:
        unprintable = sum(1 for b in body if not 0x20 <= b <= 0x7E)
        encoding = "text" if len(body) >= unprintable * 8 else "base64"
    if encoding == "hex":
        return b"0x" + value.hex().encode()
    if encoding == "base64":
        return b"0s" + base64.b64encode(value)
    out = bytearray(b'"')
    for byte in body:
        if byte in (0, 0x0A, 0x0D):
            out += f"\\{byte:03o}".encode()
        elif byte in (0x22, 0x5C):
            out += bytes((0x5C, byte))
        else:
            out.append(byte)
    out += b'"'
    return bytes(out)


async def _walk(dispatch: DispatchFn, path: PathSpec, shown: str,
                logical: bool, deref: bool) -> list[tuple[PathSpec, str]]:
    """A subtree in pre-order, the way nftw hands it to getfattr -R.

    Every entry is reported, links included. A link to a directory is
    descended only when ``deref`` says so: for every entry under ``-L``,
    and for an operand itself unless ``-P``.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): the entry to report and maybe descend into.
        shown (str): its spelling in the ``# file:`` header.
        logical (bool): ``-L``, which descends every link below.
        deref (bool): whether this entry, if a link, is descended.
    """
    entries = [(path, shown)]
    try:
        stat, _ = await dispatch("stat", path, nofollow=True)
        if stat.type == FileType.SYMLINK and deref:
            stat, _ = await dispatch("stat", path)
    except FileNotFoundError:
        return entries
    if stat.type != FileType.DIRECTORY:
        return entries
    children, _ = await dispatch("readdir", path)
    for child in children:
        name = child.rstrip("/").rsplit("/", 1)[-1]
        entries.extend(await _walk(dispatch,
                                   PathSpec.from_str_path(child.rstrip("/")),
                                   f"{shown.rstrip('/')}/{name}", logical,
                                   logical))
    return entries


async def handle_getfattr(
    dispatch: DispatchFn,
    session: SessionState,
    args: list[str | PathSpec],
) -> Result:
    """getfattr: print the extended attributes of each path.

    Debian's attr 2.5.2, pinned in docker: a ``# file:`` block per path
    that has a matching attribute, names sorted, a blank line after
    each block, ``-d``/``-n`` adding ``="value"``, and the default match
    ``^user\\.`` (``-m -`` matches every name). The attributes are the
    op door's: what was set on the path. ``-h`` reads a link's own
    attributes.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): session whose cwd resolves operands.
        args (list[str | PathSpec]): the words after the command name.
    """
    spec = SPECS["getfattr"]
    parsed = parse_command(spec, [word_text(a) for a in args], session.cwd,
                           "getfattr")
    refused = attr_usage_refusal("getfattr", parsed, GETFATTR_USAGE)
    if refused is not None:
        return refused
    fl = FlagView(parse_to_kwargs(parsed), spec=spec)
    encoding = fl.as_str("encoding")
    targets = attr_operands(parsed)
    if (encoding is not None and encoding not in _ENCODINGS) or not targets:
        return result("getfattr", exit_code=2, stderr=GETFATTR_USAGE)
    pattern = fl.as_str("match")
    if pattern is None:
        pattern = _DEFAULT_MATCH
    try:
        matcher = None if pattern == "-" else re.compile(pattern)
    except re.error:
        return result("getfattr",
                      exit_code=1,
                      stderr=f'getfattr: invalid regular expression '
                      f'"{pattern}"\n')
    name = fl.as_str("name")
    dump = fl.as_bool("dump") or name is not None
    only_values = fl.as_bool("only_values")
    nofollow = fl.as_bool("no_dereference")
    absolute = fl.as_bool("absolute_names")
    out = bytearray()
    errors: list[str] = []
    failed = False
    warned = False
    for target in targets:
        typed = target.raw_path or target.virtual
        entries = [(target, typed)]
        if fl.as_bool("recursive"):
            entries = await _walk(dispatch, target, typed,
                                  fl.as_bool("logical"),
                                  not fl.as_bool("physical"))
        for path, label in entries:
            header = label
            if not absolute and label.startswith("/"):
                header = label.lstrip("/") or "."
            try:
                block, missing = await _file_block(dispatch, path, label,
                                                   header, name, matcher, dump,
                                                   only_values, encoding,
                                                   nofollow, errors)
            except OSError as exc:
                errors.append(f"getfattr: {label}: {attr_error(exc)}\n")
                failed = True
                continue
            if block and header != label and not only_values and not warned:
                errors.append("getfattr: Removing leading '/' from absolute "
                              "path names\n")
                warned = True
            out += block
            failed = failed or missing
    return result("getfattr",
                  out=bytes(out) or None,
                  exit_code=1 if failed else 0,
                  stderr="".join(errors) or None)


async def _file_block(dispatch: DispatchFn, path: PathSpec, label: str,
                      header: str, name: str | None,
                      matcher: re.Pattern[str] | None, dump: bool,
                      only_values: bool, encoding: str | None, nofollow: bool,
                      errors: list[str]) -> tuple[bytes, bool]:
    """One path's output (its ``# file:`` block, or its bare values), and
    whether an attribute it was asked for is not set.

    An attribute that is not set is reported per name and skipped; any
    other failure (the path is missing) is the caller's to report.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): the path to read.
        label (str): its spelling as typed, which messages name.
        header (str): its spelling in the ``# file:`` header, which
            drops a leading ``/`` unless ``--absolute-names``.
        name (str | None): the one attribute ``-n`` asked for.
        matcher (re.Pattern[str] | None): the ``-m`` filter, None for all.
        dump (bool): print values, not only names.
        only_values (bool): print bare values and no header.
        encoding (str | None): the ``-e`` encoding.
        nofollow (bool): read a link's own attributes.
        errors (list[str]): message accumulator.
    """
    if name is not None:
        names = [name]
    else:
        listed, _ = await dispatch("listxattr", path, nofollow=nofollow)
        names = [n for n in listed if matcher is None or matcher.search(n)]
    out = bytearray()
    block = bytearray()
    missing = False
    for attr in names:
        if not dump and not only_values:
            block += attr.encode() + b"\n"
            continue
        try:
            value, _ = await dispatch("getxattr",
                                      path,
                                      name=attr,
                                      nofollow=nofollow)
        except OSError as exc:
            if classify(exc) is not FsCondition.NO_XATTR:
                raise
            errors.append(f"{label}: {attr}: {attr_error(exc)}\n")
            missing = True
            continue
        if only_values:
            out += value
        else:
            block += attr.encode() + b"=" + encode_value(value,
                                                         encoding) + b"\n"
    if block:
        out += f"# file: {header}\n".encode() + block + b"\n"
    return bytes(out), missing
