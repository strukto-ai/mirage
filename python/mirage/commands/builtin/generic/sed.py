import re
from collections.abc import AsyncIterator, Awaitable, Callable

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
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    in_place: bool = False,
    suppress: bool = False,
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if ";" in expression or "{" in expression:
        commands = _parse_program(expression)
    else:
        commands = [_parse_one_command(expression)[0]]

    if paths and _is_simple_sub(commands, suppress):
        parsed = commands[0]
        re_flags = re.IGNORECASE if "i" in parsed["expr_flags"] else 0
        count = 0 if "g" in parsed["expr_flags"] else 1

        if in_place:
            writes: dict[str, bytes] = {}
            for p in paths:
                data = await read_bytes(accessor, p)
                text = data.decode(errors="replace")
                new_text = re.sub(parsed["pattern"],
                                  parsed["replacement"],
                                  text,
                                  count=count,
                                  flags=re_flags)
                new_data = new_text.encode()
                await write_bytes(accessor, p, new_data)
                writes[p.original] = new_data
            return None, IOResult(writes=writes,
                                  cache=[p.original for p in paths])

        outputs: list[str] = []
        for p in paths:
            data = await read_bytes(accessor, p)
            text = data.decode(errors="replace")
            new_text = re.sub(parsed["pattern"],
                              parsed["replacement"],
                              text,
                              count=count,
                              flags=re_flags)
            outputs.append(new_text)
        return "".join(outputs).encode(), IOResult(
            cache=[p.original for p in paths])

    if paths:
        modifying = in_place and any(c["cmd"] in ("s", "d") for c in commands)
        all_outputs: list[str] = []
        writes = {}
        for p in paths:
            data = await read_bytes(accessor, p)
            text = data.decode(errors="replace")
            result = _execute_program(text, commands, suppress=suppress)
            if modifying:
                new_data = result.encode()
                await write_bytes(accessor, p, new_data)
                writes[p.original] = new_data
            else:
                all_outputs.append(result)
        if modifying:
            return None, IOResult(writes=writes,
                                  cache=[p.original for p in paths])
        return "\n".join(all_outputs).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("sed: usage: sed EXPRESSION path")
    text = raw.decode(errors="replace")
    result = _execute_program(text, commands, suppress=suppress)
    return result.encode(), IOResult()


__all__ = ["sed"]
