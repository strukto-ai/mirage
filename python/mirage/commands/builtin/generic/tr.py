from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.escapes import interpret_escapes
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error, usage_hint
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.posix import class_characters

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


def _expand_ranges(s: str) -> str:
    result: list[str] = []
    i = 0
    while i < len(s):
        if s.startswith("[:", i) and ":]" in s[i + 2:]:
            end = s.index(":]", i + 2)
            result.append(class_characters(s[i + 2:end]))
            i = end + 2
        elif i + 2 < len(s) and s[i + 1] == "-":
            start, end = ord(s[i]), ord(s[i + 2])
            result.extend(chr(c) for c in range(start, end + 1))
            i += 3
        else:
            result.append(s[i])
            i += 1
    return "".join(result)


async def _tr_stream(
    source: AsyncIterator[bytes],
    set1: str,
    set2: str,
    delete: bool,
    squeeze: bool,
    table: dict[int, int] | None,
) -> AsyncIterator[bytes]:
    prev_char = ""
    squeeze_set = set(set2) if squeeze and set2 else set(
        set1) if squeeze else set()
    async for chunk in source:
        text = chunk.decode(errors="replace")
        if delete:
            result = "".join(c for c in text if c not in set1)
        elif table is not None:
            result = text.translate(table)
        else:
            result = text
        if squeeze_set:
            squeezed: list[str] = []
            for c in result:
                if c in squeeze_set and c == prev_char:
                    continue
                squeezed.append(c)
                prev_char = c
            result = "".join(squeezed)
        elif result:
            prev_char = result[-1]
        yield result.encode()


async def tr(
    paths: list[PathSpec],
    texts: list[str],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("tr: missing operand" + _TRY_HELP)
    parsed = parse_flags(flags or {})
    # -d without -s takes one string, so the extra operand is the second
    # one: `tr -d a b c` names b (tr.c reports argv[optind + max_operands]).
    max_operands = 1 if parsed.delete and not parsed.squeeze else 2
    if len(texts) > max_operands:
        if len(texts) == 2:
            raise ValueError(
                f"tr: extra operand '{quote_text(texts[1])}'\n"
                "Only one string may be given when deleting without "
                "squeezing repeats." + _TRY_HELP)
        raise extra_operand_error(CommandName.TR, texts[max_operands])
    set1 = _expand_ranges(interpret_escapes(texts[0]))
    if parsed.complement:
        all_chars = "".join(chr(i) for i in range(128))
        set1 = "".join(ch for ch in all_chars if ch not in set1)
    set2 = _expand_ranges(interpret_escapes(
        texts[1])) if len(texts) >= 2 else ""

    if set2 and parsed.truncate_set1:
        set1 = set1[:len(set2)]
    elif set2 and len(set2) < len(set1):
        set2 = set2 + set2[-1] * (len(set1) - len(set2))

    table: dict[int, int] | None = None
    if not parsed.delete and set2:
        table = str.maketrans(set1, set2[:len(set1)])
    elif not parsed.delete and not set2 and not parsed.squeeze:
        raise ValueError(
            f"tr: missing operand after '{quote_text(texts[0])}'\n"
            "Two strings must be given when translating." + _TRY_HELP)

    cache: list[str] = []
    if paths:
        source: AsyncIterator[bytes] = read_stream(paths[0])
        cache = [paths[0].mount_path]
    else:
        source = resolve_source(stdin)

    return _tr_stream(source,
                      set1,
                      set2,
                      delete=parsed.delete,
                      squeeze=parsed.squeeze,
                      table=table), IOResult(cache=cache)


__all__ = ["tr"]
