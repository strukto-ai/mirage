from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from mirage.execution.process.handle import ProcessHandle
from mirage.io.async_line_iterator import SharedInput
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.shell.console import JobConsole
from mirage.shell.types import TSNodeLike
from mirage.workspace.session.session import SessionState


class ProcessSubLine(Protocol):
    async def __call__(
        self,
        text: str,
        *,
        stdin: ByteSource | None = None,
        sink: JobConsole | None = None,
        started: Callable[[ProcessHandle, SessionState], None] | None = None,
    ) -> IOResult: ...


@dataclass
class PipeWriter:
    """The one program writing a pipe a pipeline stage reads.

    Args:
        pipe (ByteSource): the pipe, as the stage is handed it.
        words (tuple[str | None, ...]): the program's words, None for
            one only known when it runs.
        cwd (str): the folder the pipeline started in, which the program
            runs from whatever folder its reader moves to.
        placed (bool): whether ``machine`` has been asked, which it is
            once for the pipe.
        machine (str | None): the machine the program runs on; None
            before it is asked, and for a program Mirage runs itself.
        pinned (bool): whether the config names that machine for the
            program (``config_pins``), rather than Mirage picking it;
            asked with ``machine``.
    """

    pipe: ByteSource
    words: tuple[str | None, ...]
    cwd: str
    placed: bool = False
    machine: str | None = None
    pinned: bool = False


@dataclass
class ExecutionFrame:
    """Temporary state of one evaluation; never part of a session record.

    ``shell`` is the process whose shell the evaluation runs in (a line,
    a subshell, a pipeline stage, a nested shell, a job that runs
    commands of its own), each program of which a signal the shell
    ignores still reaches; None where the evaluation is one program run
    in place (``sleep 3 &``). ``reports`` are the report lines of the
    jobs a signal ended that the running command reaped, which go out
    after its stderr, around a redirect of its own; a command
    substitution's shell, and the shells it forks, make none
    (``substitution``). ``writers`` are the processes the running
    command's substitutions started, each with the ``/dev/fd`` path a
    ``<( )`` gave it, None for a ``$( )``, which its program reads; the
    commands a command runs (a function's body) keep its ``<( )``, as
    bash's inherit the descriptor.
    ``stdin`` is the pipe a pipeline stage reads, which a program the
    stage starts reads too while its standard input is still that pipe.
    ``stdin_writer`` is the one program that writes that pipe
    (``gen | tee log``), None when the stage before is anything else,
    and in a pipeline with no process table: what the stage writes is
    about the machine that program runs on. A child shell that reads the
    same pipe keeps it (``gen | (tee log)``).
    ``ending`` is the id of the command a job runs as a whole, whose
    redirects its shell never puts back: it ends with the command, so
    bash keeps no copy of what they replace.
    ``folder_holders`` are the machines holding each folder a command of
    the line stood in, by folder, asked once for the whole line and
    shared by every frame it forks (``folder_holders``).
    """

    diagnostics: list[str | bytes] = field(default_factory=list)
    reports: list[bytes] = field(default_factory=list)
    cmdsub_seq: int = 0
    cmdsub_status: int = 0
    process_sub: (
        Callable[[TSNodeLike, ProcessSubLine], Awaitable[str]] | None
    ) = None
    routing: RouteDecision[RuntimeIdentity] | None = None
    runs_on_machine: Callable[..., bool] | None = None
    line_timeout: float | None = None
    shell: ProcessHandle | None = None
    substitution: bool = False
    writers: list[tuple[str | None, int]] = field(default_factory=list)
    stdin: ByteSource | None = None
    stdin_writer: PipeWriter | None = None
    ending: int | None = None
    folder_holders: dict[str, list[str]] = field(default_factory=dict)

    def fork(self, stdin: ByteSource | None = None) -> ExecutionFrame:
        """A child evaluation's frame, which starts empty but for the
        line's routing decision, since nested lines never re-route, its
        time limit, which a job it starts runs under from its own start,
        the process whose shell it is part of, whether that shell is a
        substitution's, the writer of the pipe it reads when that is
        the pipe this frame's stage reads, and the machines the line
        found holding its folders.

        TypeScript's also carries the abort signal; here cancellation is
        the asyncio task's and is ambient.

        Args:
            stdin (ByteSource | None): the input a child shell reads in
                its parent's place (a subshell, a pipeline's first
                stage); None for one that reads none of it (a
                substitution, a job).
        """
        given = stdin.lines.input if isinstance(stdin, SharedInput) else stdin
        writer = self.stdin_writer
        return ExecutionFrame(
            routing=self.routing,
            runs_on_machine=self.runs_on_machine,
            line_timeout=self.line_timeout,
            shell=self.shell,
            substitution=self.substitution,
            stdin_writer=(
                writer if writer is not None and given is writer.pipe else None
            ),
            folder_holders=self.folder_holders,
        )
