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

from dataclasses import replace

from mirage.commands.builtin.utils.limit import (CommandTimeoutError,
                                                 maybe_with_timeout,
                                                 run_with_timeout)
from mirage.commands.cli.refusal import leaf_refusal
from mirage.commands.cli.walk import walk
from mirage.commands.config import HELP_OPTION
from mirage.commands.errors import UsageError
from mirage.commands.spec import flag_kwarg_name
from mirage.commands.spec.help import render_help
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.ops.types import MountRoot, StatPath
from mirage.policy import resolve_limit
from mirage.types import PathSpec, Producer, word_text
from mirage.utils.params import accepts_kwarg
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.executor.command.run import exec_node
from mirage.workspace.session import Session
from mirage.workspace.types import DispatchFn, ExecutionNode


async def handle_cli(
    install: CLIInstall,
    parts: list[str | PathSpec],
    session: Session,
    stdin: ByteSource | None = None,
    dispatch: DispatchFn | None = None,
    stat_path: StatPath | None = None,
    mount_root: MountRoot | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute a line whose head word is an installed CLI.

    Dispatch is by NAME: the install resolves the program tree and the
    validated config; no mount is consulted and no operand path picks a
    backend (the one executor divergence from mount commands). The walk
    consumes subcommand words and group options; the leaf's own argv
    rides the ordinary spec machinery because a CLISpec IS a
    CommandSpec, and the leaf handler runs as
    ``fn(config, paths, *texts, **flags)`` with the installation's
    config in the accessor's seat.

    Args:
        install (CLIInstall): the resolved installation (head word,
            tree, validated config).
        parts (list[str | PathSpec]): expanded command words including
            the head; CLI words are shell-expanded strings.
        session (Session): shell session (cwd for path resolution).
        stdin (ByteSource | None): stdin data, injected as a kwarg the
            way mount command handlers receive it.
        dispatch (DispatchFn | None): workspace op dispatcher, for a CLI
            whose subject is files rather than an API.
        stat_path (StatPath | None): dispatcher-backed stat asking both
            channels a backend can answer on. Offered, not forced: a
            leaf opts in by naming the parameter (see accepts_kwarg),
            exactly as a mount command does.
        mount_root (MountRoot | None): the mount prefix serving a path,
            offered on the same terms.
    """
    # Words re-enter string space as typed (word_text): the walk owns
    # interpretation, so a quoted "Lunch?" must not arrive as the
    # glob-classified absolute /Lunch?. Leaf path operands are resolved
    # later by parse_flags against the session cwd.
    cmd_str = " ".join(word_text(p) for p in parts)
    argv = [word_text(p) for p in parts[1:]]
    stdout: ByteSource | None

    result = walk(install.name, install.spec, argv, session.cwd)
    if result.leaf is None:
        stderr = result.output if result.stream == "stderr" else b""
        stdout = result.output if result.stream == "stdout" else None
        io = IOResult(exit_code=result.exit_code, stderr=stderr)
        return stdout, io, ExecutionNode(command=cmd_str,
                                         exit_code=result.exit_code,
                                         stderr=stderr)

    prog = " ".join((install.name, ) + result.path)
    leaf = result.leaf
    # argparse add_help: every leaf answers --help with its own help
    # unless it declares the flag itself. No injected --version: that is
    # a GNU coreutils convention, not an argparse one.
    parse_spec = leaf
    if not any(option.long == "--help" for option in leaf.options):
        parse_spec = replace(leaf, options=leaf.options + (HELP_OPTION, ))

    parsed = parse_flags(list(result.argv), parse_spec, prog, session.cwd)
    if parsed.flag_kwargs.get("help") is True:
        help_text = render_help(prog, parse_spec).encode()
        return help_text, IOResult(), ExecutionNode(command=cmd_str,
                                                    exit_code=0)

    refusal = option_error(prog, parsed)
    if refusal is not None:
        # The dialect is the root's, not the leaf's: a program answers
        # in one voice at every level.
        msg, code = leaf_refusal(install.spec.usage_style, refusal[0], parsed)
        refusal_io = IOResult(exit_code=code, stderr=msg)
        refusal_node = ExecutionNode(command=cmd_str,
                                     exit_code=code,
                                     stderr=msg)
        return None, refusal_io, refusal_node

    # Group flags merge into the one bag: ancestor/descendant collisions
    # are a build-time CLISpec error, so a group flag can never shadow a
    # leaf flag.
    kw: dict[str, object] = {
        flag_kwarg_name(spelling): value
        for spelling, value in result.group_flags.items()
    }
    kw.update(parsed.flag_kwargs)
    kw.pop("help", None)
    if stdin is not None:
        kw["stdin"] = stdin

    fn = leaf.fn
    if fn is None:
        # validate_cli guarantees fn XOR subcommands and walk only
        # returns fn-bearing nodes as leaf; reaching this is a bug.
        raise RuntimeError(f"walk returned a leaf without fn for {prog!r}")
    # Workspace facts the dispatcher can offer but most CLIs do not
    # want: an API client needs no filesystem, while `git` is nothing
    # but one. A leaf opts in by naming the parameter, the same rule
    # execute_cmd applies to mount commands, so a bare **flags stays an
    # opaque bag of the user's typed flags rather than a place live
    # workspace objects turn up.
    offered = {
        "dispatch": dispatch,
        "stat_path": stat_path,
        "mount_root": mount_root,
    }
    kw.update({
        key: value
        for key, value in offered.items()
        if value is not None and accepts_kwarg(fn, key)
    })
    # The leaf's declared limit bounds the handler body and its
    # streams, exactly like mount dispatch: without the wrap a blocking
    # leaf hangs forever and an unbounded-output leaf ignores its own
    # limits.
    limit = resolve_limit(prog, command_default=leaf.limit)
    timeout = limit.timeout_seconds if limit is not None else None
    try:
        out = await run_with_timeout(
            fn(install.config, parsed.paths, *parsed.texts, **kw), timeout,
            prog)
    except UsageError as exc:
        # Leaf-raised usage errors (a malformed --json) keep the bare
        # message and exit 2, matching the refusal branch above.
        usage_stderr = f"{exc}\n".encode()
        usage_io = IOResult(exit_code=exc.exit_code, stderr=usage_stderr)
        return None, usage_io, ExecutionNode(command=cmd_str,
                                             exit_code=exc.exit_code,
                                             stderr=usage_stderr)
    except CommandTimeoutError:
        # A limit timeout is answered by the workspace-level handler
        # (exit 124), not here.
        raise
    except Exception as exc:
        # Any other thrown leaf error (an API RuntimeError, a ValueError)
        # becomes this command's IOResult, prefixed like GNU
        # (prog: message), so the rest of the line keeps running.
        err_stderr = f"{prog}: {exc}\n".encode()
        err_io = IOResult(exit_code=1, stderr=err_stderr)
        return None, err_io, ExecutionNode(command=cmd_str,
                                           exit_code=1,
                                           stderr=err_stderr)
    if out is None:
        stdout, io = None, IOResult()
    else:
        stdout, io = out
    io.producer = Producer(command=prog, declared=leaf.limit)

    if parsed.warnings:
        warn = "".join(f"{prog}: {w}\n" for w in parsed.warnings).encode()
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = warn + existing

    stdout = maybe_with_timeout(stdout, limit, prog)
    io.stderr = maybe_with_timeout(io.stderr, limit, prog)

    return stdout, io, await exec_node(cmd_str, io, parsed.paths)
