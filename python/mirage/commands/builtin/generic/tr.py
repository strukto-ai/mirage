from collections.abc import AsyncIterator, Callable, Mapping

from mirage.commands.builtin.utils.stream import resolve_source, stream_output
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import OpenStream, open_stream
from mirage.shell.bytes import byte_view
from mirage.types import PathSpec


def tr_engine(
    texts: list[str], flags: Mapping[str, FlagValue]
) -> OpenStream | IOResult:
    """tr's engine over its sets, or tr's refusal of its operands.

    Args:
        texts (list[str]): STRING1, STRING2 and any extra operand.
        flags (Mapping[str, FlagValue]): the parsed flags.
    """
    fl = FlagView(flags, spec=SPECS["tr"])
    try:
        return open_stream(
            "tr",
            {
                "operands": [byte_view(text) for text in texts],
                "delete": fl.as_bool("delete"),
                "squeeze": fl.as_bool("squeeze_repeats"),
                "complement": fl.as_bool("C") or fl.as_bool("complement"),
                "truncate_set1": fl.as_bool("truncate_set1"),
            },
        )
    except StreamRefusal as refusal:
        return refused(refusal)


def tr_generic(
    engine: OpenStream,
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run tr's engine over its input.

    Args:
        engine (OpenStream): what ``tr_engine`` opened.
        paths (list[PathSpec]): the input, glob-resolved.
        read_stream (Callable[..., AsyncIterator[bytes]]): bound reader.
        stdin (ByteSource | None): the line's input.
    """
    if paths:
        source: AsyncIterator[bytes] = read_stream(paths[0])
    else:
        source = resolve_source(stdin)
    return stream_output(engine, source), IOResult()


__all__ = ["tr_engine", "tr_generic"]
