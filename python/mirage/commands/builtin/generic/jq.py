from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.core.jq import (eval_jsonl_stream, format_jq_output,
                            has_top_level_spread, is_jsonl_path,
                            is_streamable_jsonl_expr, jq_eval, parse_json_docs)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _read_stdin_bytes(stdin: ByteSource | None) -> bytes:
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
    stdin: ByteSource | None = None,
    r: bool = False,
    c: bool = False,
    s: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    # GNU jq defaults the filter to "." when no expression is given
    expression = texts[0] if texts else "."
    # Must match the arity rule jq_eval used: a nested `[]` inside a
    # collector still yields one output, so a substring test would
    # explode a single array one element per line.
    spread = has_top_level_spread(expression)
    if paths:
        if is_jsonl_path(
                paths[0].virtual) and is_streamable_jsonl_expr(expression):
            source = read_stream(paths[0])
            return eval_jsonl_stream(source, expression, raw=r), IOResult()
        outputs: list[bytes] = []
        for p in paths:
            docs = parse_json_docs(await read_bytes(p))
            if s:
                result = jq_eval(docs, expression.strip())
                outputs.append(format_jq_output(result, r, c, spread))
                continue
            # jq applies the program to every document in the stream, so
            # a multi-value file evaluates per document whatever it is
            # named; only slurp collapses the stream into one array.
            for doc in docs:
                result = jq_eval(doc, expression.strip())
                outputs.append(format_jq_output(result, r, c, spread))
        return b"".join(outputs), IOResult()
    if stdin is None:
        # GNU jq: empty input -> no output, exit 0 (jq . </dev/null)
        return None, IOResult()
    raw_bytes = await _read_stdin_bytes(stdin)
    docs = parse_json_docs(raw_bytes)
    if s:
        result = jq_eval(docs, expression.strip())
        return format_jq_output(result, r, c, spread), IOResult()
    # Same stream rule as the path branch: piped input is a stream of
    # values, so each document is evaluated on its own.
    stdin_out: list[bytes] = []
    for doc in docs:
        result = jq_eval(doc, expression.strip())
        stdin_out.append(format_jq_output(result, r, c, spread))
    return b"".join(stdin_out), IOResult()


__all__ = ["jq"]
