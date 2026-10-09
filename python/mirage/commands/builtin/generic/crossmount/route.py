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

from typing import Any, Callable

from mirage.commands.builtin.generic.crossmount.detect import strategy_for
from mirage.commands.builtin.generic.crossmount.du import run_du
from mirage.commands.builtin.generic.crossmount.fanout import run_fanout
from mirage.commands.builtin.generic.crossmount.relay import run_relay
from mirage.commands.builtin.generic.crossmount.search import run_search
from mirage.commands.builtin.generic.crossmount.stream import run_stream
from mirage.commands.builtin.generic.crossmount.types import (
    Cmd,
    CrossResult,
    RunSingle,
    Strategy,
)
from mirage.commands.builtin.generic.crossmount.utils import (
    merge_operand_ios,
    run_operands,
)
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.config import AggregateFn
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit_code
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import format_fs_error
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import CheckFn, PathSpec
from mirage.view.types import NamespaceView, SessionView


async def handle_cross_mount(
    cmd_name: str,
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    run_single: RunSingle,
    stdin: ByteSource | None = None,
    storage_key: Callable[[PathSpec], str] | None = None,
    ns: NamespaceView | None = None,
    session_view: SessionView | None = None,
    cwd: str = "/",
    argv: tuple[str, ...] = (),
    aggregate: AggregateFn | None = None,
    check_unlink: CheckFn | None = None,
) -> CrossResult:
    """Run a command whose path operands span mounts.

    Every command combines per-mount work under one of three strategies
    (see ``Strategy``): STREAM merges raw per-operand bytes and runs the
    command once on the merged stream, FANOUT runs the command natively
    once per operand and combines the outputs, RELAY moves per-file data
    through the dispatcher into one shared generic. STREAM and FANOUT
    execute through ``run_single``, so each mount expands its own glob
    operands and uses its own native command implementation. grep, rg
    and du compose each mount's own command instead: a search from its
    owned scopes (``run_search``), du from its measurement (``run_du``).

    Args:
        cmd_name (str): Command name, such as ``cp``, ``sort``, or ``grep``.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (grep pattern,
            find expression).
        flag_kwargs (dict): Flags parsed from the shared command spec.
        dispatch (DispatchFn): Workspace operation dispatcher (RELAY).
        run_single (RunSingle): Executor-injected single-mount runner
            (STREAM, FANOUT and RELAY's wc).
        stdin (ByteSource | None): Original stdin, which a ``-`` operand
            reads.
        storage_key (Callable | None): Maps an operand to its storage
            identity (RELAY's transfer commands).
        check_unlink (CheckFn | None): Refuses a move's source whose
            mount cannot condition the delete, before anything is copied.
        ns (NamespaceView | None): Name-plane facts for the RELAY
            generics that render them (ls).
        session_view (SessionView | None): The session view, for
            the RELAY generic that renders the session's profile (ls).
        cwd (str): The session's working directory, which a typed
            operand resolves against (cp's link sources).
        argv (tuple[str, ...]): Original argument spellings for diagnostics.
        aggregate (AggregateFn | None): The reducer every operand's mount
            registered for a custom command, which then runs once per
            operand and reduces the outputs.
    """
    native = run_single
    input_source = resolve_source(stdin)

    async def run_input(
        name: str,
        paths: list[PathSpec],
        texts: list[str],
        flags: dict[str, FlagValue],
        **options: Any,
    ) -> CrossResult:
        if any(is_stdin(path) for path in paths):
            options["stdin"] = input_source
        return await native(name, paths, texts, flags, **options)

    run_single = run_input
    try:
        if aggregate is not None:
            results = await run_operands(
                run_single, cmd_name, scopes, text_args, flag_kwargs
            )
            body = await aggregate(
                [(r.scope.virtual, r.data) for r in results]
            )
            return body, await merge_operand_ios(
                results, max((r.io.exit_code for r in results), default=0)
            )
        if cmd_name in ("grep", "rg"):
            return await run_search(
                cmd_name,
                scopes,
                text_args,
                flag_kwargs,
                dispatch,
                run_single,
                cwd,
                ns,
                input_source,
            )
        if cmd_name == Cmd.DU:
            return await run_du(
                scopes,
                text_args,
                flag_kwargs,
                dispatch,
                run_single,
                cwd,
                ns,
                input_source,
            )
        strategy = strategy_for(cmd_name)
        if strategy is Strategy.RELAY:
            return await run_relay(
                cmd_name,
                scopes,
                text_args,
                flag_kwargs,
                dispatch,
                run_single,
                storage_key,
                ns,
                session_view,
                stdin,
                cwd,
                argv,
                check_unlink,
            )
        if strategy is Strategy.STREAM:
            return await run_stream(
                cmd_name, scopes, text_args, flag_kwargs, run_single
            )
        return await run_fanout(
            cmd_name, scopes, text_args, flag_kwargs, run_single
        )
    except UsageError as exc:
        # The command's own usage refusal (cmp's bad skip, an extra
        # operand) is its result, and the rest of the line runs, as the
        # single-mount path answers it.
        return None, IOResult(
            exit_code=exc.exit_code, stderr=encode_text(f"{exc}\n")
        )
    except FS_ERRORS as exc:
        return None, IOResult(
            exit_code=read_fail_exit_code(cmd_name, exc),
            stderr=format_fs_error(cmd_name, exc, scopes),
        )
