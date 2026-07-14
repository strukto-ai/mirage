from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def look(
    paths: list[PathSpec],
    prefix: str,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    fold_case: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 1:
        raise extra_operand_error(CommandName.LOOK, paths[1].raw_path)
    if paths:
        raw = await read_bytes(accessor, paths[0])
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raw = b""
    text = raw.decode(errors="replace")
    cmp_prefix = prefix.lower() if fold_case else prefix
    matched: list[str] = []
    for line in split_lines(text):
        cmp_line = line.lower() if fold_case else line
        if cmp_line.startswith(cmp_prefix):
            matched.append(line)
    if not matched:
        return None, IOResult(exit_code=1)
    return ("\n".join(matched) + "\n").encode(), IOResult()


__all__ = ["look"]
