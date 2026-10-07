import posixpath
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass

from mirage.commands.builtin.constants import (
    SED_MISSING_SCRIPT,
    SED_NO_INPUT_EXIT,
    SED_NO_INPUT_FILES,
)
from mirage.commands.builtin.sed_exec import (
    SED_LINE_LENGTH,
    SedFileContent,
    SedFileError,
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
    looks_ahead,
)
from mirage.commands.builtin.utils.paths import dispatch_stat
from mirage.commands.builtin.utils.stream import (
    read_stdin_async,
    stdin_bytes,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit_code
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import eacces, eisdir, fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.render import fs_error_line
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import (
    byte_view,
    decode_text,
    encode_text,
    from_byte_view,
    utf8_locale,
)
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.path import resolve_path

ReadBytes = Callable[..., Awaitable[bytes]]
WriteBytes = Callable[..., Awaitable[None]]


@dataclass(frozen=True)
class _Doors:
    """How sed reaches the files its script names.

    ``r``, ``R``, ``w``, ``W`` and ``s///w`` go through the workspace
    dispatcher when there is one, so a name on another mount works as it
    does for awk's redirections, and through this mount's own read and
    write otherwise.
    """

    read_bytes: ReadBytes
    write_bytes: WriteBytes | None
    dispatch: DispatchFn | None
    cwd: str
    prefix: str

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
        path = self.spec(name)
        if self.dispatch is None:
            return await self.read_bytes(path)
        # A keyed store reads a directory as nothing at all, so the stat
        # goes first to fail it the way a POSIX read does.
        if (
            await dispatch_stat(self.dispatch, path)
        ).type == FileType.DIRECTORY:
            raise eisdir(path)
        data, _ = await self.dispatch("read", path)
        return await materialize(data)

    async def write(self, name: str, data: bytes) -> None:
        path = self.spec(name)
        if self.dispatch is not None:
            await self.dispatch("write", path, data=data)
            return
        if self.write_bytes is None:
            raise eacces(name)
        await self.write_bytes(path, data)


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


async def _open_write_files(names: Sequence[str], doors: _Doors) -> str | None:
    """Truncate the ``w`` files as GNU opens them when it compiles.

    In order; the first that cannot be opened is GNU's panic.

    Args:
        names (Sequence[str]): the files, in the order they were opened.
        doors (_Doors): the file doors.
    """
    for name in names:
        if name in (SED_STDOUT, SED_STDERR):
            continue
        try:
            await doors.write(name, b"")
        except FS_ERRORS as exc:
            return _open_failure(name, exc)
    return None


async def _read_script_files(
    names: Sequence[str], doors: _Doors, utf8: bool = False
) -> dict[str, SedFileContent]:
    """Read the files ``r`` or ``R`` names.

    A file that cannot be opened reads as empty, as POSIX asks, and a
    directory opens and then fails to read, which GNU reports and exits 4
    on when it gets there.

    Args:
        names (Sequence[str]): the file names.
        doors (_Doors): the file doors.
        utf8 (bool): read them as text, under a UTF-8 locale.
    """
    files: dict[str, SedFileContent] = {}
    for name in names:
        try:
            files[name] = SedFileText(byte_view(await doors.read(name), utf8))
        except IsADirectoryError:
            files[name] = SedFileError(
                f"sed: read error on {name}: Is a directory\n"
            )
        except FS_ERRORS:
            files[name] = None
    return files


async def _flush_write_files(
    machine: SedMachine, doors: _Doors, edited: frozenset[str] = frozenset()
) -> str:
    """Write out what the ``w`` files collected.

    A ``w`` file that -i then edited keeps the edit: GNU's stream still
    points at the file -i renamed over.

    Args:
        machine (SedMachine): the finished machine.
        doors (_Doors): the file doors.
        edited (frozenset[str]): virtual paths -i rewrote.
    """
    err = ""
    for name, out in machine.wfiles.items():
        if not out.chunks or doors.spec(name).virtual in edited:
            continue
        try:
            await doors.write(
                name, from_byte_view("".join(out.chunks), machine.opts.utf8)
            )
        except FS_ERRORS as exc:
            err += _open_failure(name, exc)
    return err


def _failed(stderr: str, exit_code: int) -> tuple[None, IOResult]:
    return None, IOResult(exit_code=exit_code, stderr=encode_text(stderr))


async def sed(
    paths: list[PathSpec],
    script: str | Sequence[SedScriptPiece],
    *,
    read_bytes: ReadBytes,
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
        read_bytes (ReadBytes): bound whole-file reader.
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
    if not in_place:
        read_bytes = stdin_bytes(read_bytes, stdin)
    pieces = (
        [SedScriptPiece("expr", script)] if isinstance(script, str) else script
    )
    doors = _Doors(read_bytes, write_bytes, dispatch, cwd, prefix)
    try:
        program = compile_script(pieces, extended, utf8)
    except SedError as exc:
        refused = await _open_write_files(exc.wfiles, doors)
        if refused is not None:
            return _failed(refused, 4)
        return _failed(f"{exc}\n", exc.exit_code)
    refused = await _open_write_files(program.wfiles, doors)
    if refused is not None:
        return _failed(refused, 4)
    machine = SedMachine(
        program,
        SedRunOptions(
            suppress=suppress,
            separate=in_place or separate,
            line_length=line_length,
            files=await _read_script_files(program.rfiles, doors, utf8),
            reader_files=await _read_script_files(
                program.reader_files, doors, utf8
            ),
            utf8=utf8,
        ),
    )
    if in_place:
        return await _run_in_place(
            paths, program, machine, doors, read_bytes, write_bytes
        )

    inputs: list[SedInput] = []
    if not paths:
        raw = await read_stdin_async(stdin) or b""
        inputs.append(SedInput("-", byte_view(raw, utf8)))
    # sed owns its exit code rather than letting the executor's
    # chokepoint pick it, because GNU sed splits a failed operand two
    # ways (GNU sed 4.9). An OPEN error (a missing file) is exit 2,
    # reported when the run reaches it, and the remaining operands still
    # process: `sed -n p nope ok.txt ok2.txt` prints both files. A READ
    # error (a directory, which opens fine and then fails) is exit 4 and
    # FATAL: `sed -n p dir ok.txt` prints nothing and `sed -n p ok.txt dir
    # ok2.txt` stops after ok.txt. A `q` before an operand means GNU never
    # opens it, so it is not reported either. The operands after a
    # directory are still read: the lookahead for `$` opens a directory,
    # finds no data in it and goes on (`sed -n '$p' ok.txt dir ok2.txt`
    # prints ok2.txt's last line, exit 0). Only `$`, `n` and `N` look
    # ahead, and under -s never into the next file, so otherwise nothing
    # past the directory is read.
    look_ahead = looks_ahead(program) and not separate
    for p in paths:
        if inputs and inputs[-1].fatal and not look_ahead:
            break
        try:
            data = await read_bytes(p)
        except FS_ERRORS as exc:
            fatal = isinstance(exc, IsADirectoryError)
            inputs.append(
                SedInput(
                    p.raw_path,
                    error=fs_error_line("sed", p, exc),
                    code=read_fail_exit_code("sed", exc),
                    fatal=fatal,
                )
            )
            continue
        inputs.append(SedInput(p.raw_path, byte_view(data, utf8)))
    machine.process(inputs, True)
    write_err = await _flush_write_files(machine, doors)
    stderr = machine.stderr() + write_err
    return from_byte_view("".join(machine.stdout.chunks), utf8), IOResult(
        exit_code=machine.exit_code() if not write_err else 4,
        stderr=encode_text(stderr) if stderr else None,
    )


async def _run_in_place(
    paths: list[PathSpec],
    program: SedProgram,
    machine: SedMachine,
    doors: _Doors,
    read_bytes: ReadBytes,
    write_bytes: WriteBytes | None,
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
        doors (_Doors): the file doors.
        read_bytes (ReadBytes): bound whole-file reader.
        write_bytes (WriteBytes | None): bound writer.
    """
    utf8 = machine.opts.utf8
    if not paths:
        return _failed(f"{SED_NO_INPUT_FILES}\n", SED_NO_INPUT_EXIT)
    if write_bytes is None:
        raise NotImplementedError(
            "sed: in-place edit (-i) is not supported on this backend"
        )
    writes: dict[str, ByteSource] = {}
    edited: list[PathSpec] = []
    err = ""
    code = 0
    for p in paths:
        if machine.stopped():
            break
        try:
            data = await read_bytes(p)
        except FS_ERRORS as exc:
            err += fs_error_line("sed", p, exc)
            code = max(code, read_fail_exit_code("sed", exc))
            if isinstance(exc, IsADirectoryError):
                break
            continue
        if edited:
            # An `r` file edited by an earlier file of this command reads
            # with its new content.
            machine.set_files(
                await _read_script_files(program.rfiles, doors, utf8)
            )
        out = machine.process(
            [SedInput(p.raw_path, byte_view(data, utf8))], False
        )
        if machine.panic_code is not None:
            break
        new_data = from_byte_view(out, utf8)
        try:
            await write_bytes(p, new_data)
        except FS_ERRORS as exc:
            err += _edit_failure(p.raw_path, exc)
            code = 4
            break
        writes[p.mount_path] = new_data
        edited.append(p)
    write_err = await _flush_write_files(
        machine, doors, frozenset(p.virtual for p in edited)
    )
    stderr = err + machine.stderr() + write_err
    if machine.panic_code is not None:
        exit_code = machine.panic_code
    elif write_err or code == 4:
        exit_code = 4
    else:
        exit_code = code or machine.exit_code()
    stdout = "".join(machine.stdout.chunks)
    return from_byte_view(stdout, utf8) if stdout else None, IOResult(
        writes=writes,
        cache=[p.mount_path for p in edited],
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
    read_bytes: ReadBytes,
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
        read_bytes (ReadBytes): Bound whole-file reader.
        write_bytes (WriteBytes | None): Bound writer, None when the
            backend is read-only.
    """
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
        read_bytes=read_bytes,
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
