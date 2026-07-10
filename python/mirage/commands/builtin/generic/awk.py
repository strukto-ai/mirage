import re
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.awk_types import (CMP_OP_PATTERN,
                                                       FIELD_PREFIX,
                                                       PRINT_STMT, AwkBlock,
                                                       AwkBoolOp, AwkBuiltin,
                                                       AwkCmpOp)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def _parse_program(program: str) -> tuple[str, str]:
    program = program.strip()
    if program.startswith("{"):
        return "", program[1:].rstrip("}")
    if "{" in program:
        idx = program.index("{")
        condition = program[:idx].strip()
        action = program[idx + 1:].rstrip("}").strip()
        return condition, action
    return program, ""


def _resolve_token(tok: str, field_map: dict[str, str]) -> str:
    if tok.startswith(FIELD_PREFIX):
        inner = tok[1:]
        if inner in field_map:
            ref = field_map[inner]
            return field_map.get(f"{FIELD_PREFIX}{ref}", "")
        return field_map.get(tok, tok)
    return field_map.get(tok, tok)


def _eval_simple(expr: str, field_map: dict[str, str]) -> bool:
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


def _eval_condition(condition: str, field_map: dict[str, str]) -> bool:
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


def _eval_action(action: str, field_map: dict[str, str], fs: str) -> str:
    parts: list[str] = []
    for stmt in action.split(";"):
        stmt = stmt.strip()
        if not stmt:
            continue
        if stmt.startswith(PRINT_STMT):
            args = stmt[len(PRINT_STMT):].strip()
            if not args:
                parts.append(field_map.get(AwkBuiltin.REC, ""))
            else:
                tokens = re.split(r",\s*", args)
                vals: list[str] = []
                for tok in tokens:
                    tok = tok.strip()
                    if tok.startswith('"') and tok.endswith('"'):
                        vals.append(tok[1:-1])
                    else:
                        vals.append(_resolve_token(tok, field_map))
                parts.append(" ".join(vals))
    return "\n".join(parts) if parts else ""


def _build_field_map(line: str, fs: str, nr: int,
                     variables: dict[str, str]) -> dict[str, str]:
    fields = re.split(re.escape(fs) if len(fs) == 1 else fs,
                      line) if fs else line.split()
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


def _awk_eval_line(
    line: str,
    program: str,
    fs: str,
    variables: dict[str, str],
    nr: int,
) -> str | None:
    field_map = _build_field_map(line, fs, nr, variables)
    condition, action = _parse_program(program)
    if condition and not _eval_condition(condition, field_map):
        return None
    if not action:
        return line
    return _eval_action(action, field_map, fs)


def _eval_end_print(action: str, accum: dict, end_map: dict[str, str]) -> str:
    parts = []
    for stmt in action.split(";"):
        stmt = stmt.strip()
        if not stmt.startswith(PRINT_STMT):
            continue
        args = stmt[len(PRINT_STMT):].strip()
        if not args:
            continue
        tokens = re.split(r",\s*", args)
        vals = []
        for tok in tokens:
            tok = tok.strip()
            if tok.startswith('"') and tok.endswith('"'):
                vals.append(tok[1:-1])
            elif tok in accum:
                v = accum[tok]
                vals.append(str(int(v)) if v == int(v) else str(v))
            elif tok in end_map:
                vals.append(end_map[tok])
            else:
                vals.append(tok)
        parts.append(" ".join(vals))
    return "\n".join(parts)


def _eval_begin(action: str) -> str:
    parts = []
    for stmt in action.split(";"):
        stmt = stmt.strip()
        if not stmt.startswith(PRINT_STMT):
            continue
        args = stmt[len(PRINT_STMT):].strip()
        if not args:
            parts.append("")
            continue
        tokens = re.split(r",\s*", args)
        vals = []
        for tok in tokens:
            tok = tok.strip()
            if tok.startswith('"') and tok.endswith('"'):
                vals.append(tok[1:-1])
            else:
                vals.append(tok)
        parts.append(" ".join(vals))
    return "\n".join(parts)


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


def _eval_accumulator(action: str, field_map: dict, accum: dict) -> None:
    for stmt in action.split(";"):
        stmt = stmt.strip()
        m = re.match(r"(\w+)\s*\+=\s*(.+)", stmt)
        if m:
            var, expr = m.group(1), m.group(2).strip()
            val = field_map.get(expr, expr)
            try:
                accum[var] = accum.get(var, 0) + float(val)
            except ValueError:
                pass


async def _awk_stream(
    source: AsyncIterator[bytes],
    program: str,
    fs: str,
    variables: dict[str, str],
) -> AsyncIterator[bytes]:
    begin, main, end = _parse_blocks(program)
    accum: dict[str, float] = {}
    nr = 0

    if begin:
        result = _eval_begin(begin)
        if result:
            yield (result + "\n").encode()

    async for line_bytes in AsyncLineIterator(source):
        nr += 1
        line = line_bytes.decode(errors="replace")
        if main:
            field_map = _build_field_map(line, fs, nr, variables)
            condition, action = _parse_program(main)
            if condition and not _eval_condition(condition, field_map):
                continue

            _eval_accumulator(action, field_map, accum)

            result = _awk_eval_line(line, main, fs, variables, nr)
            if result is not None and result:
                yield (result + "\n").encode()

    if end:
        end_map = {AwkBuiltin.NR: str(nr), AwkBuiltin.NF: "0"}
        result = _eval_end_print(end, accum, end_map)
        if result:
            yield (result + "\n").encode()


def _strip_mount(virtual_path: str, prefix: str) -> str:
    if prefix and virtual_path.startswith(prefix + "/"):
        return "/" + virtual_path[len(prefix):].lstrip("/")
    return virtual_path


async def awk(
    paths: list[PathSpec],
    texts: tuple[str, ...],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    field_separator: str | None = None,
    variable_assignment: str | list[str] | None = None,
    program_file: PathSpec | None = None,
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if program_file is not None:
        f_path = program_file.mount_path
        program = (await read_bytes(accessor,
                                    f_path)).decode(errors="replace").strip()
        mount_prefix = mount_prefix_of(
            paths[0].virtual,
            paths[0].resource_path) if paths else mount_prefix_of(
                program_file.virtual, program_file.resource_path)
        data_paths = [_strip_mount(t, mount_prefix)
                      for t in texts] + [p.mount_path for p in paths]
    elif texts:
        program = texts[0]
        data_paths = [p.mount_path for p in paths]
    else:
        raise ValueError(
            "awk: usage: awk [-F fs] [-v var=val] 'program' [file ...]")

    fs = field_separator if field_separator else " "
    variables: dict[str, str] = {}
    assignments = ([variable_assignment] if isinstance(
        variable_assignment, str) else variable_assignment or [])
    for assignment in assignments:
        if "=" in assignment:
            key, val = assignment.split("=", 1)
            variables[key] = val

    cache: list[str] = []
    if data_paths:
        source: AsyncIterator[bytes] = read_stream(accessor, data_paths[0])
        cache = [data_paths[0]]
    else:
        source = _resolve_source(stdin)

    return _awk_stream(source, program, fs, variables), IOResult(cache=cache)


__all__ = ["awk"]
