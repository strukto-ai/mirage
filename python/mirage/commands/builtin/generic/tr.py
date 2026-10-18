from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
    usage_hint,
)
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import open_stream, stream_output
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec

_TRY_HELP = "\n" + usage_hint("tr")


@dataclass(frozen=True, slots=True)
class TrFlags:
    delete: bool = False
    squeeze: bool = False
    complement: bool = False
    truncate_set1: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> TrFlags:
    fl = FlagView(flags, spec=SPECS["tr"])
    return TrFlags(
        delete=fl.as_bool("delete"),
        squeeze=fl.as_bool("squeeze_repeats"),
        complement=fl.as_bool("C") or fl.as_bool("complement"),
        truncate_set1=fl.as_bool("truncate_set1"),
    )


async def tr_generic(
    paths: list[PathSpec],
    texts: list[str],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise missing_operand_error(CommandName.TR, None)
    parsed = parse_flags(flags or {})
    # -d without -s takes one string, so the extra operand is the second
    # one: `tr -d a b c` names b, the first past the strings it takes.
    operand_limit = 1 if parsed.delete and not parsed.squeeze else 2
    if len(texts) > operand_limit:
        if len(texts) == 2:
            raise ValueError(
                f"tr: extra operand '{quote_text(texts[1])}'\n"
                "Only one string may be given when deleting without "
                "squeezing repeats." + _TRY_HELP
            )
        raise extra_operand_error(CommandName.TR, texts[operand_limit])
    config: dict[str, JsonValue] = {
        "set1": byte_view(texts[0]),
        "set2": byte_view(texts[1]) if len(texts) >= 2 else None,
        "delete": parsed.delete,
        "squeeze": parsed.squeeze,
        "complement": parsed.complement,
        "truncate_set1": parsed.truncate_set1,
    }
    try:
        engine = open_stream("tr", config)
    except StreamRefusal as refusal:
        message = refusal.message
        if message == "tr: missing translation operand":
            message = (
                f"tr: missing operand after '{quote_text(texts[0])}'\n"
                "Two strings must be given when translating." + _TRY_HELP
            )
        raise ValueError(message) from refusal

    if paths:
        source: AsyncIterator[bytes] = read_stream(paths[0])
    else:
        source = resolve_source(stdin)

    return stream_output(engine, source), IOResult()


__all__ = ["tr_generic"]
