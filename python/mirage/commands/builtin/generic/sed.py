import posixpath
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.constants import (SED_MISSING_SCRIPT,
                                               SED_NO_INPUT_EXIT,
                                               SED_NO_INPUT_FILES)
from mirage.commands.builtin.sed_script import (SedCommand, execute_program,
                                                parse_one_command,
                                                parse_program)
from mirage.commands.builtin.utils.stream import (is_stdin, read_stdin_async,
                                                  stdin_bytes)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def _is_simple_sub(commands: list[SedCommand], suppress: bool) -> bool:
    return (len(commands) == 1 and commands[0]["cmd"] == "s"
            and commands[0].get("addr_start") is None and not suppress)


async def sed(
    paths: list[PathSpec],
    expression: str,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]] | None,
    stdin: ByteSource | None = None,
    in_place: bool = False,
    suppress: bool = False,
    extended: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not in_place:
        read_bytes = stdin_bytes(read_bytes, stdin)
    if ";" in expression or "{" in expression or "\n" in expression:
        commands = parse_program(expression)
    else:
        commands = [parse_one_command(expression)[0]]

    if paths and _is_simple_sub(commands, suppress):
        # Run the substitution through the per-line engine rather than a single
        # whole-buffer re.sub: ^/$ must anchor per line and a non-global s///
        # substitutes the first match on *each* line, matching GNU sed. A
        # buffer-wide re.sub anchors at the buffer ends and only touches the
        # first match overall. See strukto-ai/mirage#326.
        # sed owns its exit code here rather than letting the
        # executor's chokepoint pick it, because GNU sed splits a failed
        # operand two ways (GNU sed 4.9). An OPEN error (a missing file)
        # is exit 2, reported, and the remaining operands still process:
        # `sed -n p nope ok.txt ok2.txt` prints both files. A READ error
        # (a directory, which opens fine and then fails) is exit 4 and
        # FATAL: `sed -n p dir ok.txt` prints nothing, `sed -n p ok.txt
        # dir ok2.txt` stops after ok.txt, and `sed -n p dir dir` reports
        # one line, not two. Hence the running max for the code and the
        # break for the read error; every other command in this family
        # continues past a directory, and only sed does not.
        err = b""
        code = 0
        if in_place:
            if write_bytes is None:
                raise NotImplementedError(
                    "sed: in-place edit (-i) is not supported on this backend")
            writes: dict[str, ByteSource] = {}
            edited: list[PathSpec] = []
            for p in paths:
                try:
                    data = await read_bytes(p)
                except FS_ERRORS as exc:
                    err += fs_error_line("sed", p, exc).encode()
                    code = max(code, read_fail_exit("sed", exc))
                    if isinstance(exc, IsADirectoryError):
                        break
                    continue
                text = data.decode(errors="replace")
                new_text = execute_program(text,
                                           commands,
                                           suppress=suppress,
                                           extended=extended)
                new_data = new_text.encode()
                await write_bytes(p, new_data)
                writes[p.mount_path] = new_data
                edited.append(p)
            return None, IOResult(writes=writes,
                                  cache=[p.mount_path for p in edited],
                                  exit_code=code,
                                  stderr=err or None)

        outputs: list[str] = []
        read_ok: list[PathSpec] = []
        for p in paths:
            try:
                data = await read_bytes(p)
            except FS_ERRORS as exc:
                err += fs_error_line("sed", p, exc).encode()
                code = max(code, read_fail_exit("sed", exc))
                if isinstance(exc, IsADirectoryError):
                    break
                continue
            text = data.decode(errors="replace")
            new_text = execute_program(text,
                                       commands,
                                       suppress=suppress,
                                       extended=extended)
            outputs.append(new_text)
            read_ok.append(p)
        return "".join(outputs).encode(), IOResult(
            cache=[p.mount_path for p in read_ok if not is_stdin(p)],
            exit_code=code,
            stderr=err or None)

    if paths:
        # GNU -i redirects the whole output stream to the file whatever the
        # script ran: `p` doubles lines in place, `q` truncates, `a`/`i`/`c`
        # land their text. Gating on the command set left every non-s/d
        # script printing to stdout while reporting success (#326 corpus).
        modifying = in_place
        all_outputs: list[str] = []
        writes = {}
        err = b""
        code = 0
        edited = []
        for p in paths:
            try:
                data = await read_bytes(p)
            except FS_ERRORS as exc:
                err += fs_error_line("sed", p, exc).encode()
                code = max(code, read_fail_exit("sed", exc))
                if isinstance(exc, IsADirectoryError):
                    break
                continue
            text = data.decode(errors="replace")
            result = execute_program(text,
                                     commands,
                                     suppress=suppress,
                                     extended=extended)
            if modifying:
                if write_bytes is None:
                    raise NotImplementedError(
                        "sed: in-place edit (-i) is not supported on this "
                        "backend")
                new_data = result.encode()
                await write_bytes(p, new_data)
                writes[p.mount_path] = new_data
                edited.append(p)
            else:
                all_outputs.append(result)
        if modifying:
            return None, IOResult(writes=writes,
                                  cache=[p.mount_path for p in edited],
                                  exit_code=code,
                                  stderr=err or None)
        # GNU concatenates per-file output with no separator (each file's
        # output already carries its own newlines).
        return "".join(all_outputs).encode(), IOResult(exit_code=code,
                                                       stderr=err or None)

    raw = await read_stdin_async(stdin)
    if raw is None:
        return None, IOResult(exit_code=SED_NO_INPUT_EXIT,
                              stderr=f"{SED_NO_INPUT_FILES}\n".encode())
    text = raw.decode(errors="replace")
    result = execute_program(text,
                             commands,
                             suppress=suppress,
                             extended=extended)
    return result.encode(), IOResult()


__all__ = ["sed"]


@dataclass(frozen=True, slots=True)
class SedFlags:
    in_place: bool = False
    suppress: bool = False
    extended: bool = False
    expressions: tuple[str, ...] = ()
    script_files: tuple[PathSpec, ...] = ()


def parse_flags(flags: Mapping[str, FlagValue]) -> SedFlags:
    fl = FlagView(flags, spec=SPECS["sed"])
    return SedFlags(
        in_place=fl.as_bool("i"),
        suppress=fl.as_bool("n"),
        extended=fl.as_bool("E") or fl.as_bool("r"),
        expressions=tuple(fl.as_list("e")),
        script_files=tuple(fl.as_paths("f")),
    )


def _positional_as_paths(texts: list[str],
                         cwd: PathSpec | str) -> list[PathSpec]:
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
        resolved = (posixpath.normpath(t) if t.startswith("/") else
                    posixpath.normpath(posixpath.join(base, t)))
        slash = resolved.rfind("/")
        out.append(
            PathSpec(
                virtual=resolved,
                directory=resolved[:slash + 1] if slash >= 0 else "/",
                resolved=True,
                vfs_path=mount_key(resolved, prefix),
            ))
    return out


async def sed_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    resolve_glob: Callable[..., Awaitable[list[PathSpec]]],
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]] | None,
) -> tuple[ByteSource | None, IOResult]:
    """Run sed over the given operands; mirrors sedGeneric.

    The script comes from -e expressions and -f script files (joined
    with newlines, -e then -f as grep does) when any were given,
    otherwise from the first positional operand. The default
    stream-to-stdout path is read-only and works on every backend; only
    in-place editing needs a write op (#382).

    Args:
        paths (list[PathSpec]): The path operands, unresolved.
        texts (list[str]): Positional words (script, or files under -e/-f).
        opts (CommandOpts): Flags, stdin and cwd from the dispatcher.
        resolve_glob (Callable): Expands globs against the backend.
        read_bytes (Callable): Bound whole-file reader.
        write_bytes (Callable | None): Bound writer, None when the
            backend is read-only.
    """
    parsed = parse_flags(opts.flags)
    script_parts = list(parsed.expressions)
    for pf in parsed.script_files:
        data = await read_bytes(pf)
        text = data.decode(errors="replace")
        if text.endswith("\n"):
            text = text[:-1]
        script_parts.append(text)
    flag_script = bool(parsed.expressions or parsed.script_files)
    if not flag_script and texts:
        script_parts.append(texts[0])
    script = "\n".join(script_parts) if script_parts else None
    if script is None:
        return None, IOResult(exit_code=1,
                              stderr=f"{SED_MISSING_SCRIPT}\n".encode())
    if parsed.in_place and write_bytes is None:
        raise PermissionError("-i not supported on this backend")
    operands = list(paths)
    if flag_script:
        # With -e/-f the positional operand is a file, not the script.
        operands = _positional_as_paths(list(texts), opts.cwd) + operands
    if operands:
        operands = await resolve_glob(operands)
    return await sed(
        operands,
        script,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        stdin=opts.stdin,
        in_place=parsed.in_place,
        suppress=parsed.suppress,
        extended=parsed.extended,
    )
