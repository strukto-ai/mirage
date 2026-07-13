import re
from collections.abc import (AsyncIterator, Awaitable, Callable, Mapping,
                             Sequence)

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.awk_types import (  # yapf: disable
    CMP_OP_PATTERN, FIELD_PREFIX, PRINT_STMT, USAGE, AwkBlock, AwkBoolOp,
    AwkBuiltin, AwkCmpOp, AwkFlags)
from mirage.commands.builtin.utils.formatting import format_number, to_number
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def parse_flags(fl: FlagView) -> AwkFlags:
    """Read the raw awk flag kwargs into a frozen struct.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    raw_f = fl.raw("f")
    if isinstance(raw_f, PathSpec):
        program_files: tuple[PathSpec, ...] = (raw_f, )
    elif isinstance(raw_f, list):
        program_files = tuple(p for p in raw_f if isinstance(p, PathSpec))
    else:
        program_files = ()
    return AwkFlags(
        field_separator=fl.str("F"),
        assignments=tuple(fl.list("v")),
        program_files=program_files,
    )


def _parse_program(program: str) -> tuple[str, str]:
    program = program.strip()
    if program.startswith("{"):
        return "", program[1:].rstrip().removesuffix("}").strip()
    if "{" in program:
        idx = program.index("{")
        condition = program[:idx].strip()
        action = program[idx + 1:].rstrip().removesuffix("}").strip()
        return condition, action
    return program, ""


def _resolve_token(tok: str, field_map: Mapping[str, str]) -> str:
    if tok.startswith(FIELD_PREFIX):
        inner = tok[1:]
        if inner in field_map:
            ref = field_map[inner]
            return field_map.get(f"{FIELD_PREFIX}{ref}", "")
        return field_map.get(tok, tok)
    return field_map.get(tok, tok)


def _eval_simple(expr: str, field_map: Mapping[str, str]) -> bool:
    expr = expr.strip()
    m = re.match(rf"(.+?)\s*({CMP_OP_PATTERN})\s*(.+)", expr)
    if not m:
        if expr.startswith("/") and expr.endswith("/"):
            regex = expr[1:-1]
            return bool(re.search(regex, field_map.get(AwkBuiltin.REC, "")))
        val = _resolve_token(expr, field_map)
        try:
            return float(val) != 0
        except ValueError:
            return bool(val)
    lhs_raw, op, rhs_raw = m.group(1).strip(), m.group(2), m.group(3).strip()
    rhs_raw = rhs_raw.strip('"')
    lhs = _resolve_token(lhs_raw, field_map)
    rhs = _resolve_token(rhs_raw, field_map) if rhs_raw.startswith(
        FIELD_PREFIX) or rhs_raw in field_map else rhs_raw
    try:
        lhs_n, rhs_n = float(lhs), float(rhs)
        return {
            AwkCmpOp.EQ: lhs_n == rhs_n,
            AwkCmpOp.NE: lhs_n != rhs_n,
            AwkCmpOp.GT: lhs_n > rhs_n,
            AwkCmpOp.LT: lhs_n < rhs_n,
            AwkCmpOp.GE: lhs_n >= rhs_n,
            AwkCmpOp.LE: lhs_n <= rhs_n,
        }[AwkCmpOp(op)]
    except ValueError:
        if op == AwkCmpOp.EQ:
            return lhs == rhs
        if op == AwkCmpOp.NE:
            return lhs != rhs
        return False


def _eval_condition(condition: str, field_map: Mapping[str, str]) -> bool:
    condition = condition.strip()
    if condition == AwkBlock.BEGIN or condition == AwkBlock.END:
        return False
    if AwkBoolOp.OR in condition:
        return any(
            _eval_condition(p, field_map)
            for p in condition.split(AwkBoolOp.OR))
    if AwkBoolOp.AND in condition:
        return all(
            _eval_condition(p, field_map)
            for p in condition.split(AwkBoolOp.AND))
    return _eval_simple(condition, field_map)


def _eval_action(action: str, field_map: Mapping[str, str]) -> str | None:
    parts: list[str] = []
    printed = False
    for stmt in action.split(";"):
        stmt = stmt.strip()
        if not stmt.startswith(PRINT_STMT):
            continue
        printed = True
        args = stmt[len(PRINT_STMT):].strip()
        if not args:
            parts.append(field_map.get(AwkBuiltin.REC, ""))
            continue
        tokens = re.split(r",\s*", args)
        vals: list[str] = []
        for tok in tokens:
            tok = tok.strip()
            if tok.startswith('"') and tok.endswith('"'):
                vals.append(tok[1:-1])
            else:
                vals.append(_resolve_token(tok, field_map))
        parts.append(" ".join(vals))
    return "\n".join(parts) if printed else None


def _split_fields(line: str, fs: str | None) -> list[str]:
    if fs is None or fs == " ":
        return line.split()
    if fs == "":
        return list(line)
    return re.split(re.escape(fs) if len(fs) == 1 else fs, line)


def _build_field_map(line: str, fs: str | None, nr: int,
                     variables: Mapping[str, str]) -> dict[str, str]:
    fields = _split_fields(line, fs)
    field_map = {
        AwkBuiltin.REC: line,
        AwkBuiltin.NR: str(nr),
        AwkBuiltin.NF: str(len(fields)),
    }
    for i, f in enumerate(fields, 1):
        field_map[f"{FIELD_PREFIX}{i}"] = f
    for k, v in variables.items():
        field_map[k] = v
    return field_map


def _parse_blocks(program: str) -> tuple[str, str, str]:
    begin = ""
    end = ""
    main = program

    begin_match = re.match(rf"{AwkBlock.BEGIN}\s*\{{([^}}]*)\}}\s*(.*)",
                           program, re.DOTALL)
    if begin_match:
        begin = begin_match.group(1).strip()
        main = begin_match.group(2).strip()

    end_match = re.search(rf"{AwkBlock.END}\s*\{{([^}}]*)\}}\s*$", main)
    if end_match:
        end = end_match.group(1).strip()
        main = main[:end_match.start()].strip()

    return begin, main, end


def _eval_accumulator(action: str, field_map: Mapping[str, str],
                      accum: dict[str, float]) -> None:
    for stmt in action.split(";"):
        m = re.match(r"(\w+)\s*\+=\s*(.+)", stmt.strip())
        if m:
            var, expr = m.group(1), m.group(2).strip()
            val = field_map.get(expr, expr)
            accum[var] = accum.get(var, 0.0) + to_number(val)


async def _awk_stream(
    sources: Sequence[AsyncIterator[bytes]],
    program: str,
    fs: str | None,
    variables: dict[str, str],
) -> AsyncIterator[bytes]:
    begin, main, end = _parse_blocks(program)
    condition, action = _parse_program(main) if main else ("", "")
    accum: dict[str, float] = {}
    nr = 0

    if begin:
        begin_map = {
            AwkBuiltin.REC: "",
            AwkBuiltin.NR: "0",
            AwkBuiltin.NF: "0",
        } | variables
        result = _eval_action(begin, begin_map)
        if result is not None:
            yield (result + "\n").encode()

    for source in sources:
        async for line_bytes in AsyncLineIterator(source):
            nr += 1
            if not main:
                continue
            line = line_bytes.decode(errors="replace")
            field_map = _build_field_map(line, fs, nr, variables)
            if condition and not _eval_condition(condition, field_map):
                continue
            _eval_accumulator(action, field_map, accum)
            result = _eval_action(action, field_map) if action else line
            if result is not None:
                yield (result + "\n").encode()

    if end:
        end_map = {
            AwkBuiltin.REC: "",
            AwkBuiltin.NR: str(nr),
            AwkBuiltin.NF: "0",
        } | variables
        for k, v in accum.items():
            end_map[k] = format_number(v)
        result = _eval_action(end, end_map)
        if result is not None:
            yield (result + "\n").encode()


async def awk(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, object] | None = None,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run the mini-awk program over backend paths or stdin.

    Interprets the raw flag kwargs itself (TS awkGeneric parity), so backend
    wrappers only wire paths, texts, flags, and backend I/O.

    Args:
        paths (list[PathSpec]): Data files to process in order. Empty paths
            consume stdin.
        texts (Sequence[str]): positional TEXT operands (the program unless
            -f supplied it).
        flags (Mapping[str, object] | None): raw flag kwargs from the
            dispatcher (F, v, f).
        read_bytes (Callable[..., Awaitable[bytes]]): Whole-file reader used
            for the -f program file.
        read_stream (Callable[..., AsyncIterator[bytes]]): Streaming reader
            for data files.
        accessor (Accessor | None): Backend accessor passed through wrapper
            helpers.
        stdin (AsyncIterator[bytes] | bytes | None): Input used when paths is
            empty.
        index (IndexCacheStore | None): Optional cache index for wrapped
            backend calls.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
    fl = FlagView(flags, spec=SPECS["awk"])
    f = parse_flags(fl)

    if f.program_files:
        pieces: list[str] = []
        for prog in f.program_files:
            try:
                raw = await read_bytes(accessor, prog)
            except FileNotFoundError as exc:
                # GNU awk exits 2 when a -f program file cannot be opened.
                raise UsageError(f"awk: {prog.mount_path}: "
                                 "No such file or directory") from exc
            pieces.append(raw.decode(errors="replace").strip())
        program = "\n".join(pieces)
    elif texts:
        program = texts[0]
    else:
        raise UsageError(USAGE)

    variables: dict[str, str] = {}
    for assignment in f.assignments:
        if "=" in assignment:
            key, val = assignment.split("=", 1)
            variables[key] = val

    if paths:
        sources = [read_stream(accessor, p) for p in paths]
        cache = [p.mount_path for p in paths]
    else:
        sources = [_resolve_source(stdin)]
        cache = []

    return _awk_stream(sources, program, f.field_separator,
                       variables), IOResult(cache=cache)


__all__ = ["awk", "parse_flags", "AwkFlags"]
