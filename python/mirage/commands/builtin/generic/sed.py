from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.sed_helper import (_execute_program,
                                                _parse_one_command,
                                                _parse_program)
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _is_simple_sub(commands: list[dict], suppress: bool) -> bool:
    return (len(commands) == 1 and commands[0]["cmd"] == "s"
            and commands[0].get("addr_start") is None and not suppress)


async def sed(
    paths: list[PathSpec],
    expression: str,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
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
        if in_place:
            writes: dict[str, bytes] = {}
            for p in paths:
                data = await read_bytes(accessor, p)
                text = data.decode(errors="replace")
                new_text = _execute_program(text,
                                            commands,
                                            suppress=suppress,
                                            extended=extended)
                new_data = new_text.encode()
                await write_bytes(accessor, p, new_data)
                writes[p.mount_path] = new_data
            return None, IOResult(writes=writes,
                                  cache=[p.mount_path for p in paths])

        outputs: list[str] = []
        for p in paths:
            data = await read_bytes(accessor, p)
            text = data.decode(errors="replace")
            new_text = _execute_program(text,
                                        commands,
                                        suppress=suppress,
                                        extended=extended)
            outputs.append(new_text)
        return "".join(outputs).encode(), IOResult(
            cache=[p.mount_path for p in paths])

    if paths:
        modifying = in_place and any(c["cmd"] in ("s", "d") for c in commands)
        all_outputs: list[str] = []
        writes = {}
        for p in paths:
            data = await read_bytes(accessor, p)
            text = data.decode(errors="replace")
            result = _execute_program(text,
                                      commands,
                                      suppress=suppress,
                                      extended=extended)
            if modifying:
                new_data = result.encode()
                await write_bytes(accessor, p, new_data)
                writes[p.mount_path] = new_data
            else:
                all_outputs.append(result)
        if modifying:
            return None, IOResult(writes=writes,
                                  cache=[p.mount_path for p in paths])
        return "\n".join(all_outputs).encode(), IOResult()

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
