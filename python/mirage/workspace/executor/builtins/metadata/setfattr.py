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
import binascii

from mirage.commands.spec import SPECS, parse_command
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.parser import parse_to_kwargs
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec, word_text
from mirage.workspace.executor.builtins.metadata.xattr import (
    SETFATTR_USAGE, attr_error, attr_operands, attr_usage_refusal)
from mirage.workspace.executor.builtins.shared import finish, result
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.session import SessionState

_OCTAL = b"01234567"


def decode_value(text: str) -> bytes | None:
    """A ``-v`` value as setfattr stores it, or None when it is malformed.

    ``0x`` is hex and ``0s`` base64, whitespace ignored. Anything else is
    text: surrounding double quotes are dropped when both ends have one,
    and ``\\ooo``, ``\\\\`` and ``\\"`` are decoded while any other
    backslash stays as typed.

    Args:
        text (str): the value as typed.
    """
    if len(text) > 2 and text[0] == "0" and text[1] in "xX":
        try:
            return bytes.fromhex("".join(text[2:].split()))
        except ValueError:
            return None
    if len(text) > 2 and text[0] == "0" and text[1] in "sS":
        try:
            return base64.b64decode("".join(text[2:].split()), validate=True)
        except binascii.Error:
            return None
    raw = text.encode()
    if len(raw) >= 2 and raw[0] == raw[-1] == 0x22:
        raw = raw[1:-1]
    out = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] == 0x5C:
            digits = raw[i + 1:i + 4]
            if len(digits) == 3 and all(b in _OCTAL for b in digits):
                out.append(int(digits, 8) & 0xFF)
                i += 4
                continue
            if raw[i + 1:i + 2] in (b"\\", b'"'):
                out += raw[i + 1:i + 2]
                i += 2
                continue
        out.append(raw[i])
        i += 1
    return bytes(out)


async def handle_setfattr(
    dispatch: DispatchFn,
    session: SessionState,
    args: list[str | PathSpec],
) -> Result:
    """setfattr: set or remove one extended attribute on each path.

    Debian's attr 2.5.2, pinned in docker: ``-n NAME [-v VALUE]`` sets
    it (no ``-v`` is the empty value) and ``-x NAME`` removes it;
    exactly one of the two, with ``-v`` only beside ``-n``, or the usage
    block and exit 2. A malformed hex or base64 value is ``bad input
    encoding``, exit 1. A failure on one path is reported and the rest
    are still written. The attribute lands on the op door's node table,
    which takes any name on any path (a link's own with ``-h``), as
    macOS does; Linux refuses a name outside its namespaces and a user
    attribute on a link.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): session whose cwd resolves operands.
        args (list[str | PathSpec]): the words after the command name.
    """
    spec = SPECS["setfattr"]
    parsed = parse_command(spec, [word_text(a) for a in args], session.cwd,
                           "setfattr")
    refused = attr_usage_refusal("setfattr", parsed, SETFATTR_USAGE)
    if refused is not None:
        return refused
    fl = FlagView(parse_to_kwargs(parsed), spec=spec)
    name = fl.as_str("name")
    remove = fl.as_str("remove")
    typed = fl.as_str("value")
    targets = attr_operands(parsed)
    if ((name is None) == (remove is None)
            or (remove is not None and typed is not None) or not targets):
        return result("setfattr", exit_code=2, stderr=SETFATTR_USAGE)
    value = decode_value(typed) if typed is not None else b""
    if value is None:
        return result("setfattr", exit_code=1, stderr="bad input encoding\n")
    nofollow = fl.as_bool("no_dereference")
    errors: list[str] = []
    for target in targets:
        try:
            if name is not None:
                await dispatch("setxattr",
                               target,
                               name=name,
                               value=value,
                               nofollow=nofollow)
            else:
                await dispatch("removexattr",
                               target,
                               name=remove,
                               nofollow=nofollow)
        except OSError as exc:
            shown = target.raw_path or target.virtual
            errors.append(f"setfattr: {shown}: {attr_error(exc)}\n")
    return finish("setfattr", errors)
