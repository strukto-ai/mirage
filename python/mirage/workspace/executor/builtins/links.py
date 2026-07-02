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

import time

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.utils.path import resolve_path
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


def _typed(arg: str | PathSpec) -> str:
    if isinstance(arg, PathSpec):
        return arg.raw_path or arg.virtual
    return arg


def _split_flags(
    args: list[str | PathSpec],
    known: str,
) -> tuple[set[str], list[str | PathSpec]]:
    flags: set[str] = set()
    operands: list[str | PathSpec] = []
    parsing = True
    for arg in args:
        s = arg.virtual if isinstance(arg, PathSpec) else str(arg)
        if parsing and s == "--":
            parsing = False
            continue
        if (parsing and s != "-" and len(s) >= 2 and s.startswith("-")
                and all(c in known for c in s[1:])):
            flags.update(s[1:])
            continue
        parsing = False
        operands.append(arg)
    return flags, operands


def link_flags(args: list[str | PathSpec], known: str) -> set[str]:
    flags, _ = _split_flags(args, known)
    return flags


def _abs(arg: str | PathSpec, cwd: str) -> str:
    if isinstance(arg, PathSpec):
        return arg.virtual
    return resolve_path(arg, cwd)


def handle_ln(
    namespace: Namespace,
    session: Session,
    args: list[str | PathSpec],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    flags, operands = _split_flags(args, "sfnv")
    if len(operands) < 2:
        err = b"ln: missing file operand\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="ln",
                                                         exit_code=1,
                                                         stderr=err)
    link_abs = _abs(operands[1], session.cwd)
    target_typed = _typed(operands[0])
    exists = namespace.is_link(link_abs) and "f" not in flags
    if namespace.is_mount_root(link_abs) or exists:
        err = (f"ln: failed to create symbolic link "
               f"'{_typed(operands[1])}': File exists\n").encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="ln",
                                                         exit_code=1,
                                                         stderr=err)
    namespace.symlink(link_abs, target_typed, time.time())
    out = None
    if "v" in flags:
        out = (f"'{_typed(operands[1])}' -> '{target_typed}'\n").encode()
    return out, IOResult(), ExecutionNode(command="ln", exit_code=0)


def handle_readlink(
    namespace: Namespace,
    session: Session,
    args: list[str | PathSpec],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    flags, operands = _split_flags(args, "fenm")
    if not operands:
        err = b"readlink: missing operand\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="readlink",
                                                         exit_code=1,
                                                         stderr=err)
    lines: list[str] = []
    exit_code = 0
    for op in operands:
        target = namespace.readlink(_abs(op, session.cwd))
        if target is None:
            exit_code = 1
            continue
        lines.append(target)
    if not lines:
        return None, IOResult(exit_code=exit_code), ExecutionNode(
            command="readlink", exit_code=exit_code)
    if "n" in flags:
        text = "".join(lines)
    else:
        text = "".join(line + "\n" for line in lines)
    return text.encode(), IOResult(exit_code=exit_code), ExecutionNode(
        command="readlink", exit_code=exit_code)
