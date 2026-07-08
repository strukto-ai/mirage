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

from mirage.commands.builtin.generic.crossmount.types import (Cmd, CrossResult,
                                                              RunSingle)
from mirage.io import IOResult
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.types import PathSpec


def _has_active_flags(flag_kwargs: dict) -> bool:
    return any(v not in (None, False) for v in flag_kwargs.values())


async def run_stream(cmd_name: str, scopes: list[PathSpec],
                     text_args: list[str], flag_kwargs: dict,
                     run_single: RunSingle) -> CrossResult:
    """Run a stream command (``cmd files...`` == ``cat files... | cmd``).

    Each operand's raw bytes come from a native flagless ``cat`` on its
    owning mount (which also expands the operand's glob natively); one
    native run of the real command then consumes the merged stream in its
    stdin mode, so every flag keeps its single-invocation semantics
    (continuous ``cat -n``/``nl`` numbering, one global ``sort`` order, one
    ``sed`` address space). A failed operand is skipped and reported on
    stderr, cat-style; the merged exit code is then non-zero.

    Args:
        cmd_name (str): One of the STREAM_COMMANDS.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (sed script).
        flag_kwargs (dict): Flags parsed against the shared command spec.
        run_single (RunSingle): Executor-injected single-mount runner.
    """
    merged_io = IOResult()
    sources: list[ByteSource] = []
    failed = False
    for scope in scopes:
        out, io = await run_single(Cmd.CAT, [scope], [], {})
        merged_io = await merged_io.merge(io)
        if io.exit_code != 0:
            failed = True
            continue
        if out is not None:
            sources.append(out)
    body: ByteSource = async_chain(*sources)

    if cmd_name == Cmd.CAT and not _has_active_flags(flag_kwargs):
        if failed:
            merged_io.exit_code = merged_io.exit_code or 1
        return body, merged_io

    out, io = await run_single(cmd_name, [],
                               list(text_args),
                               flag_kwargs,
                               stdin=body,
                               resolve_hint=scopes[0])
    merged_io = await merged_io.merge(io)
    if failed:
        merged_io.exit_code = merged_io.exit_code or 1
    return out, merged_io
