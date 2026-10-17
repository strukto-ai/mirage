from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn


async def comm(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    suppress1: bool = False,
    suppress2: bool = False,
    suppress3: bool = False,
    check_order: bool | None = None,
    output_delimiter: str = "\t",
    total: bool = False,
    zero_terminated: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.COMM, paths[2].raw_path or paths[2].virtual
        )
    if len(paths) < 2:
        raise missing_operand_error(
            CommandName.COMM,
            paths[-1].raw_path or paths[-1].virtual if paths else None,
        )
    read = normalized_read(read_stream)
    shared = AsyncLineIterator(resolve_source(stdin))
    readers = [
        shared if is_stdin(p) else AsyncLineIterator(read(p)) for p in paths
    ]
    io = IOResult()
    return _comm_stream(
        readers,
        io,
        (suppress1, suppress2, suppress3),
        check_order,
        output_delimiter,
        total,
        b"\0" if zero_terminated else b"\n",
        paths,
    ), io


async def _comm_stream(
    readers: list[AsyncLineIterator],
    io: IOResult,
    suppressed: tuple[bool, bool, bool],
    check_order: bool | None,
    delimiter: str,
    total: bool,
    separator: bytes,
    paths: list[PathSpec],
) -> AsyncIterator[bytes]:
    """Merge the two inputs, checking each one's order as GNU comm does.

    Each newly read line is checked against its file's previous one:
    always under --check-order, where the first disorder ends the run,
    never under --nocheck-order, and by default only once a line unique
    to one file has printed, warning once per file and closing with
    ``input is not in sorted order``. Both exit 1. A failed read ends the
    run too, named for its operand; two ``-`` operands share one stdin
    reader, and GNU, closing stdin twice, ends with ``comm: -: Bad file
    descriptor``, exit 1, before --total.

    Args:
        readers (list[AsyncLineIterator]): file 1 and file 2.
        io (IOResult): where the warnings and the status land.
        suppressed (tuple[bool, bool, bool]): -1, -2 and -3.
        check_order (bool | None): --check-order (True),
            --nocheck-order (False), or neither (None).
        delimiter (str): the column separator.
        total (bool): --total.
        separator (bytes): the record terminator.
        paths (list[PathSpec]): file 1 and file 2, as typed.
    """
    lines: list[str | None] = [None, None]
    warned = [False, False]
    counts = [0, 0, 0]
    errors: list[str] = []
    unpairable = False

    async def pull(which: int) -> bool:
        """Read file WHICH's next line; whether its order ends the run.

        Args:
            which (int): 0 for file 1, 1 for file 2.
        """
        try:
            raw = await readers[which].readline(separator)
        except FS_ERRORS as exc:
            errors.append(fs_error_line("comm", paths[which], exc))
            io.stderr, io.exit_code = "".join(errors).encode(), 1
            return True
        before = lines[which]
        line = lines[which] = (
            None if raw is None else raw.decode(errors="replace")
        )
        if (
            check_order is False
            or not (check_order or unpairable)
            or warned[which]
            or line is None
            or before is None
            or line >= before
        ):
            return False
        warned[which] = True
        errors.append(f"comm: file {which + 1} is not in sorted order\n")
        io.stderr, io.exit_code = "".join(errors).encode(), 1
        return bool(check_order)

    try:
        if await pull(0) or await pull(1):
            return
        while lines[0] is not None or lines[1] is not None:
            left, right = lines
            column = (
                1
                if right is None or (left is not None and left < right)
                else 2
                if left is None or right < left
                else 3
            )
            unpairable = unpairable or column != 3
            text = left if column != 2 else right
            counts[column - 1] += 1
            if not suppressed[column - 1]:
                yield (
                    delimiter
                    * sum(not value for value in suppressed[: column - 1])
                    + (text or "")
                ).encode() + separator
            if column != 2 and await pull(0):
                return
            if column != 1 and await pull(1):
                return
        if all(p.raw_path == "-" for p in paths):
            errors.append("comm: -: Bad file descriptor\n")
            io.stderr, io.exit_code = "".join(errors).encode(), 1
            return
        if total:
            yield (
                delimiter.join(
                    [
                        str(count)
                        for count, hidden in zip(counts, suppressed)
                        if not hidden
                    ]
                    + ["total"]
                ).encode()
                + separator
            )
        if any(warned):
            errors.append("comm: input is not in sorted order\n")
            io.stderr = "".join(errors).encode()
    finally:
        for reader in dict.fromkeys(readers):
            await reader.discard()


__all__ = ["comm"]


@dataclass(frozen=True, slots=True)
class CommFlags:
    """comm's options; ``check_order`` is the later of --check-order and
    --nocheck-order, None when neither was given."""

    suppress1: bool = False
    suppress2: bool = False
    suppress3: bool = False
    check_order: bool | None = None
    output_delimiter: str = "\t"
    total: bool = False
    zero_terminated: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> CommFlags:
    fl = FlagView(flags, spec=SPECS["comm"])
    order = [
        name
        for name, value in fl.occurrences("check_order", "nocheck_order")
        if value
    ]
    return CommFlags(
        suppress1=fl.as_bool("args_1"),
        suppress2=fl.as_bool("2"),
        suppress3=fl.as_bool("3"),
        check_order=order[-1] == "check_order" if order else None,
        output_delimiter=fl.as_str("output_delimiter") or "\t",
        total=fl.as_bool("total"),
        zero_terminated=fl.as_bool("zero_terminated"),
    )


async def comm_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
    return await comm(
        paths,
        read_stream=read_stream,
        stdin=ctx.stdin,
        suppress1=parsed.suppress1,
        suppress2=parsed.suppress2,
        suppress3=parsed.suppress3,
        check_order=parsed.check_order,
        output_delimiter=parsed.output_delimiter,
        total=parsed.total,
        zero_terminated=parsed.zero_terminated,
    )
