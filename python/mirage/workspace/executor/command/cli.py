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

from mirage.commands.cli.walk import walk
from mirage.commands.config import HELP_OPTION
from mirage.commands.spec import flag_kwarg_name
from mirage.commands.spec.help import render_help
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.executor.command.run import exec_node
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_cli(
    install: CLIInstall,
    parts: list[str | PathSpec],
    session: Session,
    stdin: ByteSource | None = None,
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
    """
    cmd_str = " ".join(p.virtual if isinstance(p, PathSpec) else p
                       for p in parts)
    argv = [p.virtual if isinstance(p, PathSpec) else p for p in parts[1:]]

    result = walk(install.name, install.spec, argv)
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
        msg, _code = refusal
        # Leaf usage errors exit 2 (argparse), regardless of the
        # USAGE_EXIT table: prog is an installed name, never a GNU tool
        # with its own pinned exit.
        refusal_io = IOResult(exit_code=2, stderr=msg)
        refusal_node = ExecutionNode(command=cmd_str, exit_code=2, stderr=msg)
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
    out = await fn(install.config, parsed.paths, *parsed.texts, **kw)
    if out is None:
        stdout, io = None, IOResult()
    else:
        stdout, io = out

    if parsed.warnings:
        warn = "".join(f"{prog}: {w}\n" for w in parsed.warnings).encode()
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = warn + existing

    return stdout, io, await exec_node(cmd_str, io, parsed.paths)
