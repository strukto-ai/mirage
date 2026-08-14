import posixpath
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line
from mirage.utils.key_prefix import mount_key, mount_prefix_of

from mirage.commands.builtin.sed_helper import (  # isort: skip
    SED_MISSING_SCRIPT, SED_NO_INPUT_EXIT, SED_NO_INPUT_FILES,
    _execute_program, _parse_one_command, _parse_program)


def _is_simple_sub(commands: list[dict[str, Any]], suppress: bool) -> bool:
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
    if ";" in expression or "{" in expression or "\n" in expression:
        commands = _parse_program(expression)
    else:
        commands = [_parse_one_command(expression)[0]]

    if paths and _is_simple_sub(commands, suppress):
        # Run the substitution through the per-line engine rather than a single
        # whole-buffer re.sub: ^/$ must anchor per line and a non-global s///
        # substitutes the first match on *each* line, matching GNU sed. A
        # buffer-wide re.sub anchors at the buffer ends and only touches the
        # first match overall. See strukto-ai/mirage#326.
        # A failed operand is skipped and reported, and the remaining
        # operands still process, per GNU sed (which keeps going on a
        # missing file; the repo exits 1 where GNU exits 2).
        err = b""
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
                    continue
                text = data.decode(errors="replace")
                new_text = _execute_program(text,
                                            commands,
                                            suppress=suppress,
                                            extended=extended)
                new_data = new_text.encode()
                await write_bytes(p, new_data)
                writes[p.mount_path] = new_data
                edited.append(p)
            return None, IOResult(writes=writes,
                                  cache=[p.mount_path for p in edited],
                                  exit_code=1 if err else 0,
                                  stderr=err or None)

        outputs: list[str] = []
        read_ok: list[PathSpec] = []
        for p in paths:
            try:
                data = await read_bytes(p)
            except FS_ERRORS as exc:
                err += fs_error_line("sed", p, exc).encode()
                continue
            text = data.decode(errors="replace")
            new_text = _execute_program(text,
                                        commands,
                                        suppress=suppress,
                                        extended=extended)
            outputs.append(new_text)
            read_ok.append(p)
        return "".join(outputs).encode(), IOResult(
            cache=[p.mount_path for p in read_ok],
            exit_code=1 if err else 0,
            stderr=err or None)

    if paths:
        modifying = in_place and any(c["cmd"] in ("s", "d") for c in commands)
        all_outputs: list[str] = []
        writes = {}
        err = b""
        edited = []
        for p in paths:
            try:
                data = await read_bytes(p)
            except FS_ERRORS as exc:
                err += fs_error_line("sed", p, exc).encode()
                continue
            text = data.decode(errors="replace")
            result = _execute_program(text,
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
                                  exit_code=1 if err else 0,
                                  stderr=err or None)
        return "\n".join(all_outputs).encode(), IOResult(
            exit_code=1 if err else 0, stderr=err or None)

    raw = await _read_stdin_async(stdin)
    if raw is None:
        return None, IOResult(exit_code=SED_NO_INPUT_EXIT,
                              stderr=f"{SED_NO_INPUT_FILES}\n".encode())
    text = raw.decode(errors="replace")
    result = _execute_program(text,
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
        prefix = mount_prefix_of(cwd.virtual, cwd.resource_path)
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
                resource_path=mount_key(resolved, prefix),
            ))
    return out


async def sed_generic(paths, texts, opts: CommandOpts, resolve_glob,
                      read_bytes, write_bytes):
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
