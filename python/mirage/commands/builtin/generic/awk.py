import re
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _parse_program(program: str) -> tuple[str, str]:
    program = program.strip()
    if program.startswith("{"):
        return "", program[1:].rstrip("}")
    if "{" in program:
        idx = program.index("{")
        condition = program[:idx].strip()
        action = program[idx + 1:].rstrip("}").strip()
        return condition, action
    return "", program


def _eval_condition(condition: str, field_map: dict[str, str]) -> bool:
    condition = condition.strip()
    if condition == "BEGIN" or condition == "END":
        return False
    for pattern in [
            r"(\$\d+|NR|NF)\s*==\s*(.+)", r"(\$\d+|NR|NF)\s*!=\s*(.+)",
            r"(\$\d+|NR|NF)\s*>\s*(.+)", r"(\$\d+|NR|NF)\s*<\s*(.+)",
            r"(\$\d+|NR|NF)\s*>=\s*(.+)", r"(\$\d+|NR|NF)\s*<=\s*(.+)"
    ]:
        m = re.match(pattern, condition)
        if m:
            lhs_key, rhs_raw = m.group(1), m.group(2).strip().strip('"')
            lhs = field_map.get(lhs_key, "")
            op = re.search(r"(==|!=|>=|<=|>|<)", condition).group(1)
            try:
                lhs_num, rhs_num = float(lhs), float(rhs_raw)
                if op == "==":
                    return lhs_num == rhs_num
                if op == "!=":
                    return lhs_num != rhs_num
                if op == ">":
                    return lhs_num > rhs_num
                if op == "<":
                    return lhs_num < rhs_num
                if op == ">=":
                    return lhs_num >= rhs_num
                if op == "<=":
                    return lhs_num <= rhs_num
            except ValueError:
                if op == "==":
                    return lhs == rhs_raw
                if op == "!=":
                    return lhs != rhs_raw
                return False
    if condition.startswith("/") and condition.endswith("/"):
        regex = condition[1:-1]
        return bool(re.search(regex, field_map.get("$0", "")))
    return True


def _eval_action(action: str, field_map: dict[str, str], fs: str) -> str:
    parts: list[str] = []
    for stmt in action.split(";"):
        stmt = stmt.strip()
        if not stmt:
            continue
        if stmt.startswith("print"):
            args = stmt[5:].strip()
            if not args:
                parts.append(field_map.get("$0", ""))
            else:
                tokens = re.split(r",\s*", args)
                vals: list[str] = []
                for tok in tokens:
                    tok = tok.strip().strip('"')
                    vals.append(field_map.get(tok, tok))
                parts.append(" ".join(vals))
    return "\n".join(parts) if parts else ""


def _awk_eval_line(
    line: str,
    program: str,
    fs: str,
    variables: dict[str, str],
    nr: int,
) -> str | None:
    fields = re.split(re.escape(fs) if len(fs) == 1 else fs,
                      line) if fs else line.split()
    nf = len(fields)
    field_map = {"$0": line, "NR": str(nr), "NF": str(nf)}
    for i, f in enumerate(fields, 1):
        field_map[f"${i}"] = f
    for k, v in variables.items():
        field_map[k] = v

    condition, action = _parse_program(program)
    if condition and not _eval_condition(condition, field_map):
        return None
    if not action:
        return line
    return _eval_action(action, field_map, fs)


def _parse_blocks(program: str) -> tuple[str, str, str]:
    begin = ""
    end = ""
    main = program

    begin_match = re.match(r"BEGIN\s*\{([^}]*)\}\s*(.*)", program, re.DOTALL)
    if begin_match:
        begin = begin_match.group(1).strip()
        main = begin_match.group(2).strip()

    end_match = re.search(r"END\s*\{([^}]*)\}\s*$", main)
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


def _eval_end_action(action: str, accum: dict) -> str:
    parts = []
    for stmt in action.split(";"):
        stmt = stmt.strip()
        if stmt.startswith("print"):
            args = stmt[5:].strip()
            if not args:
                continue
            tokens = re.split(r",\s*", args)
            vals = []
            for tok in tokens:
                tok = tok.strip().strip('"')
                if tok in accum:
                    v = accum[tok]
                    vals.append(str(int(v)) if v == int(v) else str(v))
                else:
                    vals.append(tok)
            parts.append(" ".join(vals))
    return "\n".join(parts)


async def _awk_stream(
    source: AsyncIterator[bytes],
    program: str,
    fs: str,
    variables: dict[str, str],
) -> AsyncIterator[bytes]:
    _begin, main, end = _parse_blocks(program)
    accum: dict[str, float] = {}
    nr = 0

    async for line_bytes in AsyncLineIterator(source):
        nr += 1
        line = line_bytes.decode(errors="replace")
        if main:
            fields = re.split(re.escape(fs) if len(fs) == 1 else fs,
                              line) if fs else line.split()
            field_map = {"$0": line, "NR": str(nr), "NF": str(len(fields))}
            for i, f in enumerate(fields, 1):
                field_map[f"${i}"] = f

            condition, action = _parse_program(main)
            if condition and not _eval_condition(condition, field_map):
                continue

            _eval_accumulator(action, field_map, accum)

            result = _awk_eval_line(line, main, fs, variables, nr)
            if result is not None and result:
                yield (result + "\n").encode()

    if end:
        result = _eval_end_action(end, accum)
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
    variable_assignment: str | None = None,
    program_file: PathSpec | None = None,
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if program_file is not None:
        f_path = program_file.strip_prefix
        program = (await read_bytes(accessor,
                                    f_path)).decode(errors="replace").strip()
        mount_prefix = paths[0].prefix if paths else program_file.prefix
        data_paths = [_strip_mount(t, mount_prefix)
                      for t in texts] + [p.strip_prefix for p in paths]
    elif texts:
        program = texts[0]
        data_paths = [p.strip_prefix for p in paths]
    else:
        raise ValueError(
            "awk: usage: awk [-F fs] [-v var=val] 'program' [file ...]")

    fs = field_separator if field_separator else " "
    variables: dict[str, str] = {}
    if variable_assignment and "=" in variable_assignment:
        key, val = variable_assignment.split("=", 1)
        variables[key] = val

    cache: list[str] = []
    if data_paths:
        source: AsyncIterator[bytes] = read_stream(accessor, data_paths[0])
        cache = [data_paths[0]]
    else:
        source = _resolve_source(stdin, "awk: missing input")

    return _awk_stream(source, program, fs, variables), IOResult(cache=cache)


__all__ = ["awk"]
