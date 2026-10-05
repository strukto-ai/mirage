from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from mirage.commands.builtin.utils.stream import read_stdin_async, stdin_bytes
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@dataclass(eq=False)
class _Item:
    """One node, GNU tsort's ``struct item``.

    Args:
        name (str): the token.
        count (int): predecessors not yet printed.
        successors (list[_Item]): oldest relation first; GNU links them
            newest first, so every walk runs from the end.
        qlink (_Item | None): the next node on a loop being traced.
        printed (bool): whether the node has been output.
    """

    name: str
    count: int = 0
    successors: list["_Item"] = field(default_factory=list)
    qlink: "_Item | None" = None
    printed: bool = False


def _break_loop(tree: list[_Item]) -> list[str]:
    """Trace one loop as GNU's ``detect_loop`` does and drop one relation.

    Args:
        tree (list[_Item]): every node, in GNU's tree (strcmp) order.

    Returns:
        list[str]: the loop's members, in the order GNU reports them.
    """
    loop: _Item | None = None
    while True:
        for k in tree:
            if k.count <= 0:
                continue
            if loop is None:
                loop = k
                continue
            for index in range(len(k.successors) - 1, -1, -1):
                successor = k.successors[index]
                if successor is not loop:
                    continue
                if k.qlink is None:
                    k.qlink = loop
                    loop = k
                    break
                members: list[str] = []
                node: _Item | None = loop
                while node is not None:
                    members.append(node.name)
                    after = node.qlink
                    if node is k:
                        successor.count -= 1
                        del k.successors[index]
                        break
                    node.qlink = None
                    node = after
                while node is not None:
                    after = node.qlink
                    node.qlink = None
                    node = after
                return members


def _topological_sort(
    pairs: list[tuple[str, str]],
) -> tuple[list[str], list[list[str]]]:
    """GNU tsort's order, and every loop it had to break on the way.

    Args:
        pairs (list[tuple[str, str]]): the input relations, in order.
    """
    items: dict[str, _Item] = {}
    for a, b in pairs:
        j = items.setdefault(a, _Item(a))
        k = items.setdefault(b, _Item(b))
        if a != b:
            k.count += 1
            j.successors.append(k)
    tree = [items[name] for name in sorted(items)]
    order: list[str] = []
    loops: list[list[str]] = []
    remaining = len(tree)
    while remaining > 0:
        queue = [k for k in tree if k.count == 0 and not k.printed]
        index = 0
        while index < len(queue):
            head = queue[index]
            index += 1
            order.append(head.name)
            head.printed = True
            remaining -= 1
            for successor in reversed(head.successors):
                successor.count -= 1
                if successor.count == 0:
                    queue.append(successor)
        if remaining > 0:
            loops.append(_break_loop(tree))
    return order, loops


async def tsort_generic(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 1:
        raise extra_operand_error(
            CommandName.TSORT, paths[1].raw_path or paths[1].virtual
        )
    if paths:
        raw = await stdin_bytes(read_bytes, stdin)(paths[0])
    else:
        stdin_raw = await read_stdin_async(stdin)
        raw = stdin_raw if stdin_raw is not None else b""
    text = raw.decode(errors="replace")
    tokens = text.split()
    if len(tokens) % 2 != 0:
        name = paths[0].raw_path or paths[0].virtual if paths else "-"
        msg = f"tsort: {name}: input contains an odd number of tokens\n"
        return None, IOResult(exit_code=1, stderr=msg.encode())
    pairs: list[tuple[str, str]] = []
    for idx in range(0, len(tokens), 2):
        pairs.append((tokens[idx], tokens[idx + 1]))
    order, loops = _topological_sort(pairs)
    output = "".join(f"{name}\n" for name in order).encode()
    if not loops:
        return output, IOResult()
    name = paths[0].raw_path or paths[0].virtual if paths else "-"
    report = "".join(
        f"tsort: {name}: input contains a loop:\n"
        + "".join(f"tsort: {member}\n" for member in members)
        for members in loops
    )
    return output, IOResult(exit_code=1, stderr=report.encode())


__all__ = ["tsort_generic"]
