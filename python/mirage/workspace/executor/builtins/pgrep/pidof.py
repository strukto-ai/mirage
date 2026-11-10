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

from mirage.commands.spec.standard import version_line
from mirage.execution.job import JobTable
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import job_result
from mirage.workspace.executor.builtins.machine_view import (
    machine_scope,
    with_machine,
)
from mirage.workspace.executor.builtins.pgrep.shared import (
    program_of,
    running,
)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

# Options that take nothing and change nothing here.
_ACCEPTED = "cnxz"


async def handle_pidof(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print the pids of the named programs on one line, newest first,
    among those ``ps`` shows; a line a machine, ending in it, for
    several. Any option it does not know ends it with 1 and no word.

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``pidof`` first.
        session (SessionState | None): the shell session.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    single = quiet = False
    delimiter = " "
    omit: set[str] = set()
    machine: str | None = None
    names: list[str] = []
    words = parts[1:]
    at = 0
    while at < len(words):
        word = words[at]
        at += 1
        if word == "--machine" or word.startswith("--machine="):
            _, equal, machine = word.partition("=")
            if not equal:
                machine = words[at] if at < len(words) else ""
                at += 1
            continue
        if not word.startswith("-") or word == "-":
            names.append(word)
            continue
        letters = word[1:]
        while letters:
            flag, letters = letters[0], letters[1:]
            if flag == "V":
                return (
                    version_line("pidof"),
                    IOResult(),
                    ExecutionNode(command=cmd_str, exit_code=0),
                )
            if flag == "s":
                single = True
            elif flag == "q":
                quiet = True
            elif flag in ("d", "o"):
                value = letters or (words[at] if at < len(words) else "")
                if not letters:
                    at += 1
                letters = ""
                if flag == "d":
                    delimiter = value
                else:
                    omit |= set(value.split(","))
            elif flag not in _ACCEPTED:
                return job_result(cmd_str, "", 1)
    processes = job_table.processes
    scope = machine_scope(processes, machine)
    if scope is None:
        return job_result(cmd_str, f"pidof: {machine}: no such machine\n", 1)
    rows = await running(job_table, session, scope)
    lines: list[str] = []
    found = False
    for place in scope.ids if scope.several else ("",):
        pids: list[str] = []
        for name in names:
            matched = sorted(
                (
                    info.shown_pid
                    for info in rows
                    if program_of(info) == name
                    and str(info.shown_pid) not in omit
                    and (not place or info.shown_machine == place)
                ),
                reverse=True,
            )
            pids += [str(pid) for pid in matched]
        if single:
            pids = pids[:1]
        if pids:
            found = True
            text = delimiter.join(pids)
            lines.append(with_machine(text, place) if place else text)
    out = "" if quiet else "".join(f"{line}\n" for line in lines)
    code = 0 if found else 1
    return (
        encode_text(out),
        IOResult(exit_code=code),
        ExecutionNode(command=cmd_str, exit_code=code),
    )
