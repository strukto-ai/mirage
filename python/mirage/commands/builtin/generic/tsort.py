from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _topological_sort(pairs: list[tuple[str, str]]) -> tuple[list[str], bool]:
    graph: dict[str, set[str]] = {}
    in_degree: dict[str, int] = {}
    for a, b in pairs:
        if a not in graph:
            graph[a] = set()
            in_degree.setdefault(a, 0)
        if b not in graph:
            graph[b] = set()
            in_degree.setdefault(b, 0)
        if b not in graph[a]:
            graph[a].add(b)
            in_degree[b] = in_degree.get(b, 0) + 1
    queue: deque[str] = deque()
    for node in in_degree:
        if in_degree[node] == 0:
            queue.append(node)
    result: list[str] = []
    while queue:
        node = queue.popleft()
        result.append(node)
        for neighbor in sorted(graph[node]):
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)
    has_cycle = len(result) != len(graph)
    return result, has_cycle


async def tsort(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 1:
        raise extra_operand_error(CommandName.TSORT, paths[1].raw_path
                                  or paths[1].virtual)
    if paths:
        raw = await read_bytes(accessor, paths[0])
    else:
        stdin_raw = await _read_stdin_async(stdin)
        raw = stdin_raw if stdin_raw is not None else b""
    text = raw.decode(errors="replace")
    tokens = text.split()
    if len(tokens) % 2 != 0:
        return b"tsort: odd number of tokens\n", IOResult(exit_code=1)
    pairs: list[tuple[str, str]] = []
    for idx in range(0, len(tokens), 2):
        pairs.append((tokens[idx], tokens[idx + 1]))
    result, has_cycle = _topological_sort(pairs)
    if has_cycle:
        return b"tsort: cycle detected\n", IOResult(exit_code=1)
    output = "\n".join(result) + "\n" if result else ""
    return output.encode(), IOResult()


__all__ = ["tsort"]
