# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import re
from collections.abc import AsyncIterator

from mirage.commands.builtin.grep_context import grep_context_lines
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import exit_on_empty, quiet_match
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _compile_pattern(
    pattern: str,
    ignore_case: bool = False,
    fixed_string: bool = False,
    whole_word: bool = False,
) -> re.Pattern[str]:
    flags = re.IGNORECASE if ignore_case else 0
    pat_str = re.escape(pattern) if fixed_string else pattern
    if whole_word:
        pat_str = r"\b" + pat_str + r"\b"
    return re.compile(pat_str, flags)


async def _grep_stream(
    source: AsyncIterator[bytes],
    pat: re.Pattern[str],
    invert: bool = False,
    line_numbers: bool = False,
    only_matching: bool = False,
    max_count: int | None = None,
    count_only: bool = False,
    after_context: int = 0,
    before_context: int = 0,
) -> AsyncIterator[bytes]:
    has_context = after_context > 0 or before_context > 0

    if has_context and not count_only and not only_matching:
        all_lines: list[str] = []
        async for raw_line in AsyncLineIterator(source):
            all_lines.append(raw_line.decode(errors="replace"))
        for chunk in grep_context_lines(
                all_lines,
                pat,
                invert,
                line_numbers,
                max_count,
                after_context,
                before_context,
        ):
            yield chunk
        return

    match_count = 0
    line_num = 0
    async for raw_line in AsyncLineIterator(source):
        line_num += 1
        line = raw_line.decode(errors="replace")
        hit = bool(pat.search(line))
        if invert:
            hit = not hit
        if not hit:
            continue
        if only_matching and not invert:
            for m in pat.finditer(line):
                match_count += 1
                if not count_only:
                    yield m.group().encode() + b"\n"
                if max_count and match_count >= max_count:
                    if count_only:
                        yield str(match_count).encode() + b"\n"
                    return
        else:
            match_count += 1
            if not count_only:
                if line_numbers:
                    yield f"{line_num}:{line}\n".encode()
                else:
                    yield raw_line + b"\n"
            if max_count and match_count >= max_count:
                if count_only:
                    yield str(match_count).encode() + b"\n"
                return
    if count_only:
        yield str(match_count).encode() + b"\n"


async def grep(
    ops: dict | None,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    R: bool = False,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    E: bool = False,
    o: bool = False,
    m: str | None = None,
    q: bool = False,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    e: str | None = None,
    prefix: str = "",
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if e is not None:
        pattern = e
    elif texts:
        pattern = texts[0]
    else:
        raise ValueError("grep: usage: grep [flags] pattern [path]")

    max_count = int(m) if m is not None else None
    after_ctx = int(A) if A is not None else (int(C) if C is not None else 0)
    before_ctx = int(B) if B is not None else (int(C) if C is not None else 0)

    if paths and ops is not None:
        if args_l and "grep" in ops:
            results = ops["grep"](
                paths[0],
                pattern=pattern,
                recursive=r or R,
                ignore_case=i,
                invert=v,
                line_numbers=n,
                count_only=c,
                files_only=True,
                fixed_string=F,
                only_matching=o,
                max_count=max_count,
                whole_word=w,
            )
            if not results:
                return b"", IOResult(exit_code=1)
            if prefix:
                results = [prefix + "/" + r.lstrip("/") for r in results]
            return format_records(results), IOResult()

        pat = _compile_pattern(pattern, i, F, w)
        source = ops["read_stream"](paths[0])
        stream = _grep_stream(
            source,
            pat,
            invert=v,
            line_numbers=n,
            only_matching=o,
            max_count=max_count,
            count_only=c,
            after_context=after_ctx,
            before_context=before_ctx,
        )
        if q:
            io = IOResult(exit_code=1)
            return quiet_match(stream, io), io
        io = IOResult()
        return exit_on_empty(stream, io), io

    source = _resolve_source(stdin, "grep: usage: grep [flags] pattern [path]")
    pat = _compile_pattern(pattern, i, F, w)
    stream = _grep_stream(
        source,
        pat,
        invert=v,
        line_numbers=n,
        only_matching=o,
        max_count=max_count,
        count_only=c,
        after_context=after_ctx,
        before_context=before_ctx,
    )
    if q:
        io = IOResult(exit_code=1)
        return quiet_match(stream, io), io
    io = IOResult()
    return exit_on_empty(stream, io), io
