from collections import Counter, deque

from mirage.commands.builtin.utils.stream import read_stdin_async, stdin_stream
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec, ReadStreamFn

# GNU 9.7's order, measured on 10,000 random inputs: the names nothing has
# to precede go first, in byte order, then each name as soon as every name
# that must precede it is out, a name's own followers taken newest pair
# first. When every name left still waits on another, one loop is reported
# and cut: stepping back from the smallest name left, each step takes the
# name before it that sorts next after it (wrapping round to the smallest),
# and the first name met twice closes the loop. The loop is listed from the
# last step forward and the pair that closed it is dropped, which may free
# the first name listed; if it does not, the next loop is found the same way.


def _closing_loop(start: str, leaders: dict[str, Counter[str]]) -> list[str]:
    trail: list[str] = []
    met: dict[str, int] = {}
    here = start
    while True:
        before = sorted(leaders[here])
        step = next((name for name in before if name > here), before[0])
        if step in met:
            return trail[met[step] :][::-1]
        met[step] = len(trail)
        trail.append(step)
        here = step


def _order_with_loops(
    pairs: list[tuple[str, str]],
) -> tuple[list[str], list[list[str]]]:
    names = sorted({name for pair in pairs for name in pair})
    followers: dict[str, list[str]] = {name: [] for name in names}
    leaders: dict[str, Counter[str]] = {name: Counter() for name in names}
    for first, then in pairs:
        if first != then:
            followers[first].append(then)
            leaders[then][first] += 1
    waiting = {name: leaders[name].total() for name in names}
    ready = deque(name for name in names if not waiting[name])
    placed: set[str] = set()
    order: list[str] = []
    loops: list[list[str]] = []
    lowest = 0

    def release(first: str, then: str) -> None:
        leaders[then][first] -= 1
        if not leaders[then][first]:
            del leaders[then][first]
        waiting[then] -= 1
        if not waiting[then]:
            ready.append(then)

    while True:
        while ready:
            name = ready.popleft()
            order.append(name)
            placed.add(name)
            for then in reversed(followers[name]):
                if leaders[then][name]:
                    release(name, then)
        while lowest < len(names) and names[lowest] in placed:
            lowest += 1
        if lowest == len(names):
            return order, loops
        loop = _closing_loop(names[lowest], leaders)
        loops.append(loop)
        release(loop[-1], loop[0])


async def tsort_generic(
    paths: list[PathSpec],
    *,
    stream: ReadStreamFn,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 1:
        raise extra_operand_error(
            CommandName.TSORT, paths[1].raw_path or paths[1].virtual
        )
    if paths:
        raw = await materialize(stdin_stream(stream, stdin)(paths[0]))
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
    order, loops = _order_with_loops(pairs)
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
