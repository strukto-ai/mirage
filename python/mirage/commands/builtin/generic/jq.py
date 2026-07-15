from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.core.jq import (eval_jsonl_stream, format_jq_output, is_jsonl_path,
                            is_streamable_jsonl_expr, jq_eval, parse_json_auto,
                            parse_json_path)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _read_stdin_bytes(
        stdin: AsyncIterator[bytes] | bytes | None) -> bytes:
    if isinstance(stdin, bytes):
        return stdin
    if stdin is None:
        return b""
    raw = b""
    async for chunk in stdin:
        raw += chunk
    return raw


async def jq(
    paths: list[PathSpec],
    *texts: str,
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    c: bool = False,
    s: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    # GNU jq defaults the filter to "." when no expression is given
    expression = texts[0] if texts else "."
    spread = "[]" in expression
    if paths:
        if is_jsonl_path(
                paths[0].virtual) and is_streamable_jsonl_expr(expression):
            source = read_stream(accessor, paths[0])
            return eval_jsonl_stream(source, expression, raw=r), IOResult()
        outputs: list[bytes] = []
        for p in paths:
            data = parse_json_path(await read_bytes(accessor, p), p.virtual)
            if is_jsonl_path(p.virtual) and isinstance(data, list) and not s:
                for item in data:
                    result = jq_eval(item, expression.strip())
                    outputs.append(format_jq_output(result, r, c, spread))
                continue
            if s and not isinstance(data, list):
                data = [data]
            result = jq_eval(data, expression.strip())
            outputs.append(format_jq_output(result, r, c, spread))
        return b"".join(outputs), IOResult()
    if stdin is None:
        # GNU jq: empty input -> no output, exit 0 (jq . </dev/null)
        return None, IOResult()
    raw_bytes = await _read_stdin_bytes(stdin)
    data = parse_json_auto(raw_bytes)
    if s and not isinstance(data, list):
        data = [data]
    result = jq_eval(data, expression.strip())
    return format_jq_output(result, r, c, spread), IOResult()


__all__ = ["jq"]
