from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.sed_helper import (_execute_program,
                                                _parse_one_command,
                                                _parse_program)
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line


def _is_simple_sub(commands: list[dict], suppress: bool) -> bool:
    return (len(commands) == 1 and commands[0]["cmd"] == "s"
            and commands[0].get("addr_start") is None and not suppress)


async def sed(
    paths: list[PathSpec],
    expression: str,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]] | None,
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    in_place: bool = False,
    suppress: bool = False,
    extended: bool = False,
    index: IndexCacheStore | None = None,
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
                    data = await read_bytes(accessor, p)
                except FS_ERRORS as exc:
                    err += fs_error_line("sed", p, exc).encode()
                    continue
                text = data.decode(errors="replace")
                new_text = _execute_program(text,
                                            commands,
                                            suppress=suppress,
                                            extended=extended)
                new_data = new_text.encode()
                await write_bytes(accessor, p, new_data)
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
                data = await read_bytes(accessor, p)
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
                data = await read_bytes(accessor, p)
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
                await write_bytes(accessor, p, new_data)
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
        raise ValueError("sed: usage: sed EXPRESSION path")
    text = raw.decode(errors="replace")
    result = _execute_program(text,
                              commands,
                              suppress=suppress,
                              extended=extended)
    return result.encode(), IOResult()


__all__ = ["sed"]
