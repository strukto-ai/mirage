import posixpath
import re
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import aclosing
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.constants import (
    SED_MISSING_SCRIPT,
    SED_NO_INPUT_EXIT,
    SED_NO_INPUT_FILES,
)
from mirage.commands.builtin.generic_bind.dispatch import caller_stream
from mirage.commands.builtin.sed_exec import (
    SED_LINE_LENGTH,
    SedFileContent,
    SedFileError,
    SedFileSource,
    SedFileText,
    SedInput,
    SedMachine,
    SedRunOptions,
)
from mirage.commands.builtin.sed_script import (
    SED_STDERR,
    SED_STDOUT,
    SedError,
    SedProgram,
    SedScriptPiece,
    compile_script,
)
from mirage.commands.builtin.utils.operands import (
    materialized_read,
    normalized_read,
)
from mirage.commands.builtin.utils.stream import is_stdin, stdin_stream
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit_code
from mirage.context.session_context import Caller, current_caller
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import eacces, fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.render import fs_error_line
from mirage.errors.types import FsCondition, StaleWriteError
from mirage.io.cooperative import chunks
from mirage.io.spool import ByteSpool
from mirage.io.stream import close_quietly, ensure_stream, prime_stream
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.io.writer import ByteWriter
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import (
    byte_view,
    decode_text,
    encode_text,
    from_byte_view,
    utf8_locale,
)
from mirage.types import PathSpec, PolymorphicReadFn
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import resolve_path

ReadBytes = Callable[..., Awaitable[bytes]]
WriteBytes = Callable[..., Awaitable[None]]


@dataclass
class _ScriptFiles:
    """How sed reaches the files its script names.

    ``r``, ``R``, ``w``, ``W`` and ``s///w`` go through the workspace
    dispatcher when there is one, so a name on another mount works as it
    does for awk's redirections, and through this mount's own read and
    write otherwise.
    """

    read_stream: PolymorphicReadFn
    write_bytes: WriteBytes | None
    dispatch: DispatchFn | None
    cwd: str
    prefix: str
    caller: Caller

    def spec(self, name: str) -> PathSpec:
        resolved = resolve_path(name, self.cwd)
        if self.dispatch is not None:
            return PathSpec.from_str_path(name, cwd=self.cwd)
        slash = resolved.rfind("/")
        return PathSpec(
            virtual=resolved,
            directory=resolved[: slash + 1] if slash >= 0 else "/",
            resolved=True,
            vfs_path=mount_key(resolved, self.prefix),
        )

    async def read(self, name: str) -> bytes:
        return await materialize(self.stream(name))

    async def stream(self, name: str) -> AsyncIterator[bytes]:
        path = self.spec(name)
        source = (
            normalized_read(self.read_stream)(path)
            if self.dispatch is None
            else caller_stream(self.dispatch, self.caller, path)
        )
        async with aclosing(chunks(source)) as data:
            async for part in data:
                yield part

    async def write(
        self,
        name: str,
        data: ByteSource,
        *,
        atomic: bool = False,
        append: bool = False,
    ) -> None:
        path = self.spec(name)
        if self.dispatch is not None:
            if append:
                await self.dispatch("append", path, data=data)
            else:
                await self.dispatch("write", path, data=data, atomic=atomic)
            return
        if self.write_bytes is None:
            raise eacces(name)
        async with ByteSpool() as spool:
            if append:
                await spool.fill(normalized_read(self.read_stream)(path))
            await spool.fill(data)
            await self.write_bytes(path, spool.stream())


def _line_length(raw: str | None) -> int:
    """GNU's atoi over -l.

    Leading blanks, a sign, digits; a negative length is a huge unsigned
    one, which never folds, the same as 0.

    Args:
        raw (str | None): the -l value.
    """
    if raw is None:
        return SED_LINE_LENGTH
    m = re.match(r"\s*([+-]?)(\d*)", raw)
    if m is None or not m.group(2) or m.group(1) == "-":
        return 0
    return int(m.group(2))


def _open_failure(name: str, exc: BaseException) -> str:
    strerror = fs_strerror(exc) or posix_phrase(FsCondition.EACCES)
    return f"sed: couldn't open file {name}: {strerror}\n"


def _edit_failure(name: str, exc: BaseException) -> str:
    strerror = fs_strerror(exc) or str(exc)
    return f"sed: couldn't edit {name}: {strerror}\n"


async def _open_write_files(
    names: Sequence[str], access: _ScriptFiles
) -> str | None:
    """Truncate the ``w`` files as GNU opens them when it compiles.

    In order; the first that cannot be opened is GNU's panic.

    Args:
        names (Sequence[str]): the files, in the order they were opened.
        access (_ScriptFiles): how sed reaches the files its script names.
    """
    for name in names:
        if name in (SED_STDOUT, SED_STDERR):
            continue
        try:
            await access.write(name, b"")
        except FS_ERRORS as exc:
            return _open_failure(name, exc)
    return None


async def _read_script_files(
    names: Sequence[str],
    access: _ScriptFiles,
    utf8: bool = False,
    streamed: bool = False,
) -> dict[str, SedFileContent]:
    """Read the files ``r`` or ``R`` names.

    A file that cannot be opened reads as empty, as POSIX asks, and a
    directory opens and then fails to read, which GNU reports and exits 4
    on when it gets there.

    Args:
        names (Sequence[str]): the file names.
        access (_ScriptFiles): how sed reaches the files its script names.
        utf8 (bool): read them as text, under a UTF-8 locale.
    """
    files: dict[str, SedFileContent] = {}
    for name in names:
        if streamed:
            files[name] = SedFileSource(partial(access.stream, name))
            continue
        try:
            files[name] = SedFileText(byte_view(await access.read(name), utf8))
        except IsADirectoryError:
            files[name] = SedFileError(
                f"sed: read error on {name}: Is a directory\n"
            )
        except FS_ERRORS:
            files[name] = None
    return files


class _ScriptWrites:
    """Drain sed's named outputs, one bounded writer per file for the run.

    A writer stays open until the run ends: finishing one at each switch
    between files would make every switch an append, which a store
    without native appends rewrites whole.

    GNU opens each spelling of a file (``w out``, ``w ./out``) as its own
    buffered stream from offset 0, and the first opened is flushed last:
    its bytes win, and a later spelling's show only past its end. The
    first spelling writes here; the others keep only the bytes past what
    it has written so far, for that tail.
    """

    def __init__(
        self, machine: SedMachine, access: _ScriptFiles, defer: bool
    ) -> None:
        self.machine = machine
        self.defer = defer
        self.access = access
        self.writers: dict[str, ByteWriter] = {}
        self.failed: set[str] = set()
        self.edited: set[str] = set()
        self.errors = ""
        self.first: dict[str, str] = {}
        self.later: dict[str, ByteSpool] = {}
        self.deferred: dict[str, ByteSpool] = {}
        self.sent: dict[str, int] = {}
        for name in machine.wfiles:
            if self.first.setdefault(access.spec(name).virtual, name) != name:
                self.later[name] = ByteSpool()

    async def flush(self, final: bool = False) -> None:
        for name, out in self.machine.wfiles.items():
            if not out.chunks:
                continue
            data = from_byte_view("".join(out.chunks), self.machine.opts.utf8)
            out.chunks.clear()
            path = self.access.spec(name).virtual
            if name in self.failed or path in self.edited:
                continue
            if name in self.later:
                await self.later[name].append(data)
            elif self.defer:
                if name not in self.deferred:
                    self.deferred[name] = ByteSpool()
                await self.deferred[name].append(data)
            else:
                await self._send(name, data)
        if final:
            deferred, self.deferred = self.deferred, {}
            for name, spool in deferred.items():
                async with spool:
                    if self.access.spec(name).virtual not in self.edited:
                        async for data in spool.stream():
                            await self._send(name, data)

    async def _send(self, name: str, data: bytes) -> None:
        writer = self.writers.get(name)
        if writer is None:
            writer = self.writers[name] = ByteWriter(
                partial(self.access.write, name, append=True)
            )
        try:
            await writer.write(data)
            self.sent[name] = self.sent.get(name, 0) + len(data)
        except FS_ERRORS as exc:
            self._failed(name, exc)
            del self.writers[name]
            await writer.abort()

    def _failed(self, name: str, exc: BaseException) -> None:
        self.failed.add(name)
        self.errors += _open_failure(name, exc)

    async def finish(self) -> None:
        for name, spool in self.later.items():
            path = self.access.spec(name).virtual
            first = self.first[path]
            if first not in self.failed and path not in self.edited:
                async for data in spool.stream(self.sent.get(first, 0)):
                    await self._send(first, data)
        writers, self.writers = self.writers, {}
        for name, writer in writers.items():
            try:
                await writer.finish()
            except FS_ERRORS as exc:
                self._failed(name, exc)

    async def abort(self) -> None:
        writers, self.writers = self.writers, {}
        try:
            for writer in writers.values():
                await writer.abort()
        finally:
            for spool in (*self.later.values(), *self.deferred.values()):
                await spool.close()
            self.later.clear()
            self.deferred.clear()


def _failed(stderr: str, exit_code: int) -> tuple[None, IOResult]:
    return None, IOResult(exit_code=exit_code, stderr=encode_text(stderr))


async def sed(
    paths: list[PathSpec],
    script: str | Sequence[SedScriptPiece],
    *,
    read_stream: PolymorphicReadFn,
    write_bytes: WriteBytes | None,
    stdin: ByteSource | None = None,
    in_place: bool = False,
    suppress: bool = False,
    extended: bool = False,
    separate: bool = False,
    line_length: int = SED_LINE_LENGTH,
    dispatch: DispatchFn | None = None,
    cwd: str = "/",
    prefix: str = "",
    utf8: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    """Compile a script and run it over the operands, as GNU sed 4.9.

    Args:
        paths (list[PathSpec]): the resolved operands.
        script (str | Sequence[SedScriptPiece]): one expression, or the
            -e and -f pieces in order.
        read_stream (PolymorphicReadFn): bound input reader.
        write_bytes (WriteBytes | None): bound writer, None when the
            backend is read-only.
        stdin (ByteSource | None): the input when there are no operands.
        in_place (bool): -i.
        suppress (bool): -n.
        extended (bool): -E.
        separate (bool): -s.
        line_length (int): -l.
        dispatch (DispatchFn | None): the workspace dispatcher, for the
            files the script names.
        cwd (str): the directory those names resolve against.
        prefix (str): this mount's prefix, for a name without a
            dispatcher.
        utf8 (bool): a UTF-8 locale: the script and the input are
            characters rather than bytes.
    """
    read = normalized_read(read_stream)
    pieces = (
        [SedScriptPiece("expr", script)] if isinstance(script, str) else script
    )
    access = _ScriptFiles(
        read_stream if in_place else stdin_stream(read_stream, stdin),
        write_bytes,
        dispatch,
        cwd,
        prefix,
        current_caller(),
    )
    try:
        program = compile_script(pieces, extended, utf8)
    except SedError as exc:
        refused = await _open_write_files(exc.wfiles, access)
        if refused is not None:
            return _failed(refused, 4)
        return _failed(f"{exc}\n", exc.exit_code)
    refused = await _open_write_files(program.wfiles, access)
    if refused is not None:
        return _failed(refused, 4)
    machine = SedMachine(
        program,
        SedRunOptions(
            suppress=suppress,
            separate=in_place or separate,
            line_length=line_length,
            files=await _read_script_files(
                program.rfiles, access, utf8, not in_place
            ),
            reader_files=await _read_script_files(
                program.reader_files, access, utf8, not (in_place or separate)
            ),
            utf8=utf8,
        ),
    )
    writes = _ScriptWrites(
        machine,
        access,
        in_place or bool(program.rfiles or program.reader_files),
    )
    if in_place:
        try:
            return await _run_in_place(
                paths,
                program,
                machine,
                access,
                read,
                write_bytes,
                writes,
            )
        finally:
            await writes.abort()

    stdin_source = ensure_stream(stdin or b"")
    inputs = [
        SedInput("-", source=stdin_source)
        if is_stdin(p)
        else SedInput(p.raw_path, source=read(p))
        for p in paths
    ] or [SedInput("-", source=stdin_source)]
    io = IOResult()

    async def output() -> AsyncIterator[bytes]:
        try:
            async with aclosing(
                machine.process(inputs, True, writes.flush)
            ) as chunks:
                async for chunk in chunks:
                    yield from_byte_view(chunk, utf8)
        finally:
            try:
                await writes.flush(final=True)
                await writes.finish()
            finally:
                await writes.abort()
            write_err = writes.errors
            stderr = machine.stderr() + write_err
            io.exit_code = machine.exit_code() if not write_err else 4
            io.stderr = encode_text(stderr) if stderr else None

    return output(), io


class _EditAborted(Exception):
    pass


async def _edit_output(
    machine: SedMachine,
    path: PathSpec,
    source: ByteSource,
    utf8: bool,
    writes: _ScriptWrites,
) -> AsyncIterator[bytes]:
    async with aclosing(
        machine.process(
            [SedInput(path.raw_path, source=source)], False, writes.flush
        )
    ) as output:
        async for chunk in output:
            yield from_byte_view(chunk, utf8)
    if machine.panic_code is not None:
        raise _EditAborted()


async def _run_in_place(
    paths: list[PathSpec],
    program: SedProgram,
    machine: SedMachine,
    access: _ScriptFiles,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: WriteBytes | None,
    writes: _ScriptWrites,
) -> tuple[ByteSource | None, IOResult]:
    """GNU -i: each file is its own run.

    Line numbers, ``$``, the hold space and ranges restart, and the whole
    output of that run replaces the file: ``p`` doubles lines in place,
    ``q`` truncates, ``a``/``i``/``c`` land their text. The ``w`` files,
    ``R`` readers and /dev/stdout span the files. A ``q`` stops before the
    next file; a panic leaves the file it hit untouched.

    Args:
        paths (list[PathSpec]): the files to edit.
        program (SedProgram): the compiled script.
        machine (SedMachine): the compiled script's machine.
        access (_ScriptFiles): how sed reaches the files its script names.
        read_stream (Callable): bound streaming reader.
        write_bytes (WriteBytes | None): bound writer.
        writes (_ScriptWrites): the script output writers.
    """
    utf8 = machine.opts.utf8
    if not paths:
        return _failed(f"{SED_NO_INPUT_FILES}\n", SED_NO_INPUT_EXIT)
    if write_bytes is None:
        raise NotImplementedError(
            "sed: in-place edit (-i) is not supported on this backend"
        )
    edited: list[PathSpec] = []
    err = ""
    code = 0
    for p in paths:
        if machine.stopped():
            break
        try:
            data = await prime_stream(read_stream(p))
        except FS_ERRORS as exc:
            err += fs_error_line("sed", p, exc)
            code = max(code, read_fail_exit_code("sed", exc))
            if isinstance(exc, IsADirectoryError):
                break
            continue
        try:
            if edited:
                # An `r` file edited by an earlier file of this command reads
                # with its new content.
                machine.set_files(
                    await _read_script_files(program.rfiles, access, utf8)
                )
            try:
                writes.edited.add(p.virtual)
                await access.write(
                    p.virtual,
                    _edit_output(machine, p, data, utf8, writes),
                    atomic=True,
                )
            except _EditAborted:
                break
            except StaleWriteError as exc:
                err += _edit_failure(p.raw_path, exc)
                code = 4
                break
        finally:
            await close_quietly(data)
        edited.append(p)
    await writes.flush(final=True)
    await writes.finish()
    write_err = writes.errors
    stderr = err + machine.stderr() + write_err
    if machine.panic_code is not None:
        exit_code = machine.panic_code
    elif write_err or code == 4:
        exit_code = 4
    else:
        exit_code = code or machine.exit_code()
    stdout = "".join(machine.stdout.chunks)
    return from_byte_view(stdout, utf8) if stdout else None, IOResult(
        exit_code=exit_code,
        stderr=encode_text(stderr) if stderr else None,
    )


__all__ = ["sed"]


@dataclass(frozen=True, slots=True)
class SedFlags:
    in_place: bool = False
    suppress: bool = False
    extended: bool = False
    separate: bool = False
    line_length: int = SED_LINE_LENGTH
    scripts: tuple[str | PathSpec, ...] = ()


def parse_flags(flags: Mapping[str, FlagValue]) -> SedFlags:
    fl = FlagView(flags, spec=SPECS["sed"])
    expressions = iter(fl.as_list("e"))
    files = iter(fl.as_paths("f"))
    return SedFlags(
        in_place=fl.as_bool("i"),
        suppress=fl.as_bool("n"),
        extended=fl.as_bool("E") or fl.as_bool("r"),
        separate=fl.as_bool("separate"),
        line_length=_line_length(fl.as_str("line_length")),
        scripts=tuple(
            next(expressions) if name == "e" else next(files)
            for name, _ in fl.occurrences("e", "f")
        ),
    )


def _script_origins(
    argv: Sequence[str], count: int
) -> list[str | None] | None:
    """Which -e/-f occurrences of the line were script files.

    With their names as spelled, for GNU's ``file NAME line N:``
    diagnostics. The executor reads a script file before sed runs and
    hands its text on as one more -e (so every sub-run of a fanned-out
    line sees the same program), which leaves only the line's own words to
    tell the two apart. None for an expression; the whole answer is None
    when the words are not the line's (a split run) or do not account for
    every occurrence.

    Args:
        argv (Sequence[str]): the words after ``sed``.
        count (int): how many -e/-f occurrences the flags hold.
    """
    if not argv:
        return None
    out: list[str | None] = []
    i = 0
    while i < len(argv):
        word = argv[i]
        i += 1
        if word == "--":
            break
        if word.startswith("--"):
            if word == "--line-length":
                i += 1
            continue
        if not word.startswith("-") or word == "-":
            continue
        for j in range(1, len(word)):
            c = word[j]
            if c not in "efl":
                continue
            value = word[j + 1 :]
            if not value:
                value = argv[i] if i < len(argv) else ""
                i += 1
            if c != "l":
                out.append(value if c == "f" else None)
            break
    return out if len(out) == count else None


def _positional_as_paths(
    texts: list[str], cwd: PathSpec | str
) -> list[PathSpec]:
    """Treat positional operands as files (GNU rule when -e/-f give script).

    The arg parser routes the first bare arg into the positional ``text``
    (script) slot, so recover it as a path operand carrying the mount
    prefix.

    Args:
        texts (list[str]): positional operands that are really files.
        cwd (PathSpec | str): current directory for relative resolution.
    """
    if isinstance(cwd, PathSpec):
        base = cwd.virtual
        prefix = mount_prefix_of(cwd.virtual, cwd.vfs_path)
    else:
        base = cwd or "/"
        prefix = ""
    out: list[PathSpec] = []
    for t in texts:
        resolved = (
            posixpath.normpath(t)
            if t.startswith("/")
            else posixpath.normpath(posixpath.join(base, t))
        )
        slash = resolved.rfind("/")
        out.append(
            PathSpec(
                virtual=resolved,
                directory=resolved[: slash + 1] if slash >= 0 else "/",
                resolved=True,
                vfs_path=mount_key(resolved, prefix),
            )
        )
    return out


async def sed_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    resolve_glob: Callable[..., Awaitable[list[PathSpec]]],
    read_stream: PolymorphicReadFn,
    write_bytes: WriteBytes | None,
) -> tuple[ByteSource | None, IOResult]:
    """Run sed over the given operands; mirrors sedGeneric.

    The script comes from -e expressions and -f script files, compiled
    in option order, when any were given, otherwise from the first
    positional operand. The default stream-to-stdout path is read-only
    and works on every backend; only in-place editing needs a write op
    (#382).

    Args:
        paths (list[PathSpec]): The path operands, unresolved.
        texts (list[str]): Positional words (script, or files under -e/-f).
        opts (CommandOpts): Flags, stdin and cwd from the dispatcher.
        resolve_glob (Callable[..., Awaitable[list[PathSpec]]]):
            Expands globs against the backend.
        read_stream (PolymorphicReadFn): Bound input reader.
        write_bytes (WriteBytes | None): Bound writer, None when the
            backend is read-only.
    """
    read_bytes = materialized_read(read_stream)
    parsed = parse_flags(opts.flags)
    origins = _script_origins(opts.argv, len(parsed.scripts))
    pieces: list[SedScriptPiece] = []
    for index, part in enumerate(parsed.scripts):
        shown = origins[index] if origins is not None else None
        if isinstance(part, str):
            pieces.append(
                SedScriptPiece("expr", part)
                if shown is None
                else SedScriptPiece("file", part, shown)
            )
            continue
        name = shown if shown is not None else part.raw_path
        try:
            data = await read_bytes(part)
        except FS_ERRORS as exc:
            return _failed(_open_failure(name, exc), 4)
        pieces.append(SedScriptPiece("file", decode_text(data), name))
    flag_script = bool(parsed.scripts)
    if not flag_script and texts:
        pieces.append(SedScriptPiece("expr", texts[0]))
    if not pieces:
        return _failed(f"{SED_MISSING_SCRIPT}\n", 1)
    if parsed.in_place and write_bytes is None:
        # A backend with no write op refuses the edit itself, not a file:
        # the line names no operand, so sed's step wording is not it.
        return None, IOResult(
            exit_code=1,
            stderr=b"sed: -i not supported on this backend: "
            b"Permission denied\n",
        )
    operands = list(paths)
    if flag_script:
        # With -e/-f the positional operand is a file, not the script.
        operands = _positional_as_paths(list(texts), opts.cwd) + operands
    if operands:
        operands = await resolve_glob(operands)
    cwd = (
        opts.cwd.virtual
        if isinstance(opts.cwd, PathSpec)
        else (opts.cwd or "/")
    )
    return await sed(
        operands,
        pieces,
        read_stream=read_stream,
        write_bytes=write_bytes,
        stdin=opts.stdin,
        in_place=parsed.in_place,
        suppress=parsed.suppress,
        extended=parsed.extended,
        separate=parsed.separate,
        line_length=parsed.line_length,
        dispatch=opts.dispatch,
        cwd=cwd,
        prefix=opts.mount_prefix.rstrip("/"),
        utf8=utf8_locale(opts.env),
    )
