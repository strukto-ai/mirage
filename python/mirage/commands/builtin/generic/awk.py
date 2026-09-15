import re
from collections.abc import (AsyncIterator, Awaitable, Callable, Mapping,
                             Sequence)

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.awk_types import (  # yapf: disable
    CMP_OP_PATTERN, FIELD_PREFIX, PRINT_STMT, USAGE, AwkBlock, AwkBoolOp,
    AwkBuiltin, AwkCmpOp, AwkFlags)
from mirage.commands.builtin.utils.formatting import format_number, to_number
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
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
        field_separator=fl.as_str("F"),
        assignments=tuple(fl.as_list("v")),
        program_files=program_files,
    )


_CMP_RE = re.compile(CMP_OP_PATTERN)
_STRING_QUOTE = '"'
_REGEX_DELIM = "/"
_REGEX_ERROR = ("awk: syntax error in regular expression {pattern} "
                "at source line 1")


def _literal_end(text: str, start: int) -> int | None:
    """Index just past the literal opening at ``start``.

    Covers the two literals a pattern can hold, a ``"string"`` and a
    ``/regex/``; a backslash escapes the next character in both, which
    is how ``/a\\/b/`` keeps its slash. None when the literal never
    closes.

    Args:
        text (str): the program source.
        start (int): index of the opening quote or slash.
    """
    delim = text[start]
    i = start + 1
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == delim:
            return i + 1
        i += 1
    return None


def _is_literal(tok: str) -> bool:
    return tok[:1] in (_STRING_QUOTE, _REGEX_DELIM) and _literal_end(
        tok, 0) == len(tok)


def _is_regex_literal(tok: str) -> bool:
    return tok.startswith(_REGEX_DELIM) and _is_literal(tok)


# Where a `/` opens a regex rather than dividing: at the start of a
# condition and after an operator that wants an operand.
_REGEX_OPENERS = frozenset("~!&|(,")


def _opens_regex(text: str, at: int) -> bool:
    before = text[:at].rstrip()
    return not before or before[-1] in _REGEX_OPENERS


def _split_bool(condition: str, op: str) -> list[str]:
    """Split a condition at ``op`` outside its literals.

    A ``"string"`` or a ``/regex/`` can hold the operator's characters
    (`$0 ~ /A&&B/`, `$1 == "a||b"`), so the split walks the text and
    steps over each literal whole; a ``/`` opens a regex only where awk
    expects an operand, so the slash of a bare word is not one.
    Validator and evaluator both split through here, so they cannot
    disagree about where a term ends. A literal that never closes ends
    the scan, and the validator refuses what is left.

    Args:
        condition (str): the pattern's source text.
        op (str): the boolean operator, ``&&`` or ``||``.
    """
    parts: list[str] = []
    start = 0
    i = 0
    while i < len(condition):
        ch = condition[i]
        if ch == _STRING_QUOTE or (ch == _REGEX_DELIM
                                   and _opens_regex(condition, i)):
            end = _literal_end(condition, i)
            if end is None:
                break
            i = end
        elif condition.startswith(op, i):
            parts.append(condition[start:i])
            i += len(op)
            start = i
        else:
            i += 1
    parts.append(condition[start:])
    return parts


def _action_start(program: str) -> int:
    """Index of the ``{`` that opens the action, or -1 without one.

    Literals are skipped whole, so the brace in a pattern's ``/a{2}/``
    is not mistaken for the action's.

    Args:
        program (str): the main rule's source text.
    """
    i = 0
    while i < len(program):
        ch = program[i]
        if ch in (_STRING_QUOTE, _REGEX_DELIM):
            end = _literal_end(program, i)
            if end is None:
                return -1
            i = end
            continue
        if ch == "{":
            return i
        i += 1
    return -1


def _parse_program(program: str) -> tuple[str, str]:
    program = program.strip()
    idx = _action_start(program)
    if idx == -1:
        return program, ""
    condition = program[:idx].strip()
    action = program[idx + 1:].rstrip().removesuffix("}").strip()
    return condition, action


def _split_comparison(expr: str) -> tuple[str, str, str] | None:
    """Split ``lhs OP rhs`` at the first operator outside a leading literal.

    A leading ``/regex/`` or ``"string"`` is skipped whole, so the ``<``
    inside ``/a<b/`` is not read as a comparison; after that the leftmost
    operator wins, which is how ``$0 ~ /a==b/`` keeps ``==`` in its
    regex. None when the expression is not a comparison.

    Args:
        expr (str): one simple condition, already stripped.
    """
    scan_from = 0
    if expr[:1] in (_STRING_QUOTE, _REGEX_DELIM):
        end = _literal_end(expr, 0)
        if end is None:
            return None
        scan_from = end
    m = _CMP_RE.search(expr, scan_from)
    if m is None or m.start() == 0:
        return None
    lhs = expr[:m.start()].strip()
    rhs = expr[m.end():].strip()
    if not lhs or not rhs:
        return None
    return lhs, m.group(0), rhs


def _strip_negation(expr: str) -> tuple[bool, str]:
    """Peel one leading ``!`` off a probe (``!/re/``, ``!x``).

    ``!=`` and ``!~`` are operators, not negations, so they stay put.

    Args:
        expr (str): one simple condition, already stripped.
    """
    if expr.startswith("!") and not expr.startswith(
        (AwkCmpOp.NE, AwkCmpOp.NOT_MATCH)):
        return True, expr[1:].strip()
    return False, expr


def _compile_regex(pattern: str) -> re.Pattern[str]:
    """Compile an awk regex, refusing a bad one with awk's exit 2.

    Args:
        pattern (str): the regex source, delimiters stripped.
    """
    try:
        return re.compile(pattern)
    except re.error as exc:
        raise UsageError(_REGEX_ERROR.format(pattern=pattern)) from exc


_IDENT_RE = re.compile(r"[A-Za-z_]\w*\Z")
_NUMBER_RE = re.compile(r"-?(?:\d+\.?\d*|\.\d+)\Z")


def _is_simple_operand(tok: str) -> bool:
    """Whether the scraper can evaluate this token as a value.

    The supported grammar is deliberately small: a double-quoted string
    with no embedded quote, a numeric literal, a plain identifier, or a
    ``$`` field naming a number or an identifier. Anything else (function
    calls, arithmetic, concatenation) has no evaluator here and must be
    refused rather than echoed as its own source text.

    Args:
        tok (str): the token as written in the program.
    """
    if not tok:
        return False
    if len(tok) >= 2 and tok.startswith('"') and tok.endswith('"'):
        return '"' not in tok[1:-1]
    if tok.startswith(FIELD_PREFIX):
        inner = tok[1:]
        return inner.isdigit() or bool(_IDENT_RE.match(inner))
    return bool(_IDENT_RE.match(tok) or _NUMBER_RE.match(tok))


def _reject(construct: str) -> None:
    raise UsageError(f"awk: unsupported construct: '{construct}'")


def _split_statements(action: str) -> list[str]:
    """Split an action into its leaf statements.

    Splits on ``;`` at brace depth zero and outside double quotes. A
    compound statement (``{ stmts }``, legal wherever a statement is)
    contributes its inner statements in place, so ``{{print $1}}`` runs
    ``print $1`` the way gawk does rather than reading as one unknown
    statement. Validator and evaluator both iterate this list, so they
    cannot disagree about where a statement ends.

    Args:
        action (str): the action block's source text, braces stripped.
    """
    pieces: list[str] = []
    depth = 0
    quoted = False
    start = 0
    for i, ch in enumerate(action):
        if ch == '"':
            quoted = not quoted
        elif quoted:
            continue
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(depth - 1, 0)
        elif ch == ";" and depth == 0:
            pieces.append(action[start:i])
            start = i + 1
    pieces.append(action[start:])
    stmts: list[str] = []
    for piece in pieces:
        stmt = piece.strip()
        if not stmt:
            continue
        if stmt.startswith("{") and stmt.endswith("}"):
            stmts.extend(_split_statements(stmt[1:-1]))
        else:
            stmts.append(stmt)
    return stmts


def _validate_print_args(args: str, stmt: str) -> None:
    for tok in re.split(r",\s*", args):
        if not _is_simple_operand(tok.strip()):
            _reject(stmt)


def _validate_action(action: str) -> None:
    """Refuse any statement the streamer would silently drop or mangle.

    ``_eval_statements`` executes ``print``, ``var = value`` and
    ``var += value``; every other statement used to vanish (and
    ``printf`` ran as a mangled ``print``), so an agent's script exited 0
    having done nothing. Shares the statement split with the evaluator.

    Args:
        action (str): the action block's source text.
    """
    for stmt in _split_statements(action):
        m = re.match(r"\w+\s*\+=\s*(.+)\Z", stmt)
        if m:
            if not _is_simple_operand(m.group(1).strip()):
                _reject(stmt)
            continue
        if not re.match(rf"{PRINT_STMT}\b", stmt):
            m_set = _ASSIGN_RE.match(stmt)
            if m_set:
                if not _is_simple_operand(m_set.group(2).strip()):
                    _reject(stmt)
                continue
        if stmt == PRINT_STMT:
            continue
        if re.match(rf"{PRINT_STMT}\b", stmt):
            args = stmt[len(PRINT_STMT):].strip()
            if args:
                _validate_print_args(args, stmt)
            continue
        _reject(stmt)


def _validate_simple(expr: str) -> None:
    expr = expr.strip()
    negated, probe = _strip_negation(expr)
    split = _split_comparison(probe)
    if split is None:
        if _is_regex_literal(probe):
            _compile_regex(probe[1:-1])
            return
        if not _is_simple_operand(probe):
            _reject(expr)
        return
    if negated:
        # `!$1 == 2` negates the operand, not the comparison, and nothing
        # here evaluates that shape.
        _reject(expr)
    lhs, op, rhs = split
    if not _is_simple_operand(lhs):
        _reject(expr)
    if op in (AwkCmpOp.MATCH, AwkCmpOp.NOT_MATCH):
        # A literal regex is checked now; a variable or field is a
        # dynamic regex, compiled against each record.
        if _is_literal(rhs):
            _compile_regex(rhs[1:-1])
        elif not _is_simple_operand(rhs):
            _reject(expr)
        return
    if rhs.startswith('"') or rhs.startswith(FIELD_PREFIX):
        if not _is_simple_operand(rhs):
            _reject(expr)
        return
    # A bare right-hand side compares as a literal in this dialect, so any
    # word is fine; structural characters mean an expression nothing here
    # evaluates (`length(x)`, `a[1]`).
    if any(ch in rhs for ch in "(){}["):
        _reject(expr)


def _validate_condition(condition: str) -> None:
    """Refuse any pattern ``_eval_condition`` cannot actually decide.

    Mirrors its decomposition exactly (``||`` first, then ``&&``, then one
    simple comparison / regex / truthiness probe), so everything the
    evaluator runs is accepted and everything it would misread (`~`,
    arithmetic, parenthesized groups) is refused up front.

    Args:
        condition (str): the pattern's source text.
    """
    condition = condition.strip()
    if not condition or condition in (AwkBlock.BEGIN, AwkBlock.END):
        return
    for op in (AwkBoolOp.OR, AwkBoolOp.AND):
        parts = _split_bool(condition, op)
        if len(parts) > 1:
            for part in parts:
                _validate_condition(part)
            return
    _validate_simple(condition)


def _validate_program(program: str) -> None:
    begin, main, end = _parse_blocks(program)
    condition, action = _parse_program(main) if main else ("", "")
    if begin:
        _validate_action(begin)
    if end:
        _validate_action(end)
    _validate_condition(condition)
    if action:
        _validate_action(action)


def _resolve_token(tok: str, field_map: Mapping[str, str]) -> str:
    if tok.startswith(FIELD_PREFIX):
        inner = tok[1:]
        if inner in field_map:
            ref = field_map[inner]
            return field_map.get(f"{FIELD_PREFIX}{ref}", "")
        # An out-of-range field is empty in awk, never its own spelling.
        return field_map.get(tok, "")
    if tok in field_map:
        return field_map[tok]
    # An unset variable reads as the empty string, not its own name; a
    # numeric literal is its own value.
    return "" if _IDENT_RE.match(tok) else tok


def _eval_simple(expr: str, field_map: Mapping[str, str]) -> bool:
    expr = expr.strip()
    negated, probe = _strip_negation(expr)
    split = _split_comparison(probe)
    if split is None:
        if _is_regex_literal(probe):
            record = field_map.get(AwkBuiltin.REC, "")
            hit = _compile_regex(probe[1:-1]).search(record) is not None
        else:
            val = _resolve_token(probe, field_map)
            try:
                hit = float(val) != 0
            except ValueError:
                hit = bool(val)
        return hit != negated
    lhs_raw, op, rhs_raw = split
    lhs = _resolve_token(lhs_raw, field_map)
    if op in (AwkCmpOp.MATCH, AwkCmpOp.NOT_MATCH):
        pattern = (rhs_raw[1:-1] if _is_literal(rhs_raw) else _resolve_token(
            rhs_raw, field_map))
        hit = _compile_regex(pattern).search(lhs) is not None
        return hit if op == AwkCmpOp.MATCH else not hit
    rhs_raw = rhs_raw.strip('"')
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
    parts = _split_bool(condition, AwkBoolOp.OR)
    if len(parts) > 1:
        return any(_eval_condition(p, field_map) for p in parts)
    parts = _split_bool(condition, AwkBoolOp.AND)
    if len(parts) > 1:
        return all(_eval_condition(p, field_map) for p in parts)
    return _eval_simple(condition, field_map)


_ASSIGN_RE = re.compile(r"([A-Za-z_]\w*)\s*=(?!=)\s*(.+)\Z")


def _eval_statements(action: str, field_map: dict[str, str],
                     accum: dict[str, float],
                     variables: dict[str, str]) -> str | None:
    """Run an action's statements in written order.

    Three statement forms exist in this dialect: `var += value`
    accumulates, `var = value` assigns (persisting across records via
    ``variables``, which is how ``BEGIN {OFS=":"}`` reaches every print),
    and `print` emits its arguments joined with OFS. One sequential pass,
    so `x = 1; print x` sees the assignment.

    Args:
        action (str): the action block's source text.
        field_map (dict[str, str]): the record's fields and variables.
        accum (dict[str, float]): running `+=` totals.
        variables (dict[str, str]): the program's global variables.
    """
    parts: list[str] = []
    printed = False
    for stmt in _split_statements(action):
        m_add = re.match(r"(\w+)\s*\+=\s*(.+)", stmt)
        if m_add:
            var, expr = m_add.group(1), m_add.group(2).strip()
            val = field_map.get(expr, expr)
            accum[var] = accum.get(var, 0.0) + to_number(val)
            continue
        if not stmt.startswith(PRINT_STMT):
            m_set = _ASSIGN_RE.match(stmt)
            if m_set:
                var, raw = m_set.group(1), m_set.group(2).strip()
                if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
                    val = raw[1:-1]
                else:
                    val = _resolve_token(raw, field_map)
                variables[var] = val
                field_map[var] = val
                continue
        if not stmt.startswith(PRINT_STMT):
            continue
        printed = True
        args = stmt[len(PRINT_STMT):].strip()
        ofs = field_map.get("OFS", " ")
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
        parts.append(ofs.join(vals))
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
    field_map: dict[str, str] = {
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
        result = _eval_statements(begin, begin_map, accum, variables)
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
            result = (_eval_statements(action, field_map, accum, variables)
                      if action else line)
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
        result = _eval_statements(end, end_map, accum, variables)
        if result is not None:
            yield (result + "\n").encode()


async def awk(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, FlagValue] | None = None,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[ByteSource | None, IOResult]:
    """Run the mini-awk program over backend paths or stdin.

    Interprets the raw flag kwargs itself (TS awkGeneric parity), so backend
    wrappers only wire paths, texts, flags, and backend I/O.

    Args:
        paths (list[PathSpec]): Data files to process in order. Empty paths
            consume stdin.
        texts (Sequence[str]): positional TEXT operands (the program unless
            -f supplied it).
        flags (Mapping[str, FlagValue] | None): raw flag kwargs from the
            dispatcher (F, v, f).
        read_bytes (Callable[..., Awaitable[bytes]]): Whole-file reader used
            for the -f program file.
        read_stream (Callable[..., AsyncIterator[bytes]]): Streaming reader
            for data files.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
    fl = FlagView(flags, spec=SPECS["awk"])
    f = parse_flags(fl)

    if f.program_files:
        pieces: list[str] = []
        for prog in f.program_files:
            try:
                raw = await read_bytes(prog)
            except FileNotFoundError as exc:
                # GNU awk exits 2 when a -f program file cannot be opened.
                raise UsageError(f"awk: {prog.raw_path}: "
                                 "No such file or directory") from exc
            pieces.append(raw.decode(errors="replace").strip())
        program = "\n".join(pieces)
    elif texts:
        program = texts[0]
    else:
        raise UsageError(USAGE)

    _validate_program(program)

    variables: dict[str, str] = {}
    for assignment in f.assignments:
        if "=" in assignment:
            key, val = assignment.split("=", 1)
            variables[key] = val

    if paths:
        sources = [read_stream(p) for p in paths]
        cache = [p.mount_path for p in paths]
    else:
        sources = [resolve_source(stdin)]
        cache = []

    return _awk_stream(sources, program, f.field_separator,
                       variables), IOResult(cache=cache)


__all__ = ["awk"]
