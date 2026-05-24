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

import logging
from collections.abc import AsyncIterator
from functools import partial

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.discord._provision import file_read_provision
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_files_only, grep_lines,
                                                 grep_stream)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.discord.channels import list_channels
from mirage.core.discord.entry import channel_dirname
from mirage.core.discord.formatters import format_grep_results
from mirage.core.discord.glob import resolve_glob
from mirage.core.discord.read import read as discord_read
from mirage.core.discord.readdir import readdir as _readdir
from mirage.core.discord.scope import coalesce_scopes, detect_scope
from mirage.core.discord.search import search_guild
from mirage.core.discord.stat import stat as _stat
from mirage.io.stream import exit_on_empty, quiet_match, yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def grep_provision(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "grep " + " ".join(texts + tuple(str(p) for p in paths)))


@command("grep",
         resource="discord",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: DiscordAccessor,
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
    H: bool = False,
    args_h: bool = False,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    e: str | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
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

    pushdown_warnings: list[str] = []
    if paths:
        scope = await detect_scope(paths[0], index)
        if scope.level in ("messages", "file_blob", "date"):
            coalesced = await coalesce_scopes(paths, index)
            if coalesced is not None:
                scope = coalesced

        if scope.level == "root":
            return b"", IOResult(exit_code=1,
                                 stderr=b"grep: root-level search "
                                 b"not yet supported\n")

        if scope.level in ("channel", "guild"):
            try:
                if scope.guild_id is None:
                    raise RuntimeError("cannot resolve guild ID")
                msgs = await search_guild(
                    accessor.config,
                    scope.guild_id,
                    pattern,
                    channel_id=scope.channel_id,
                    limit=max_count or 100,
                )
                file_prefix = paths[0].prefix or ""
                resource_first = scope.resource_path.split("/", 1)[0]
                channels = await list_channels(accessor.config, scope.guild_id)
                channel_map = {c["id"]: channel_dirname(c) for c in channels}
                lines = format_grep_results(msgs, file_prefix, resource_first,
                                            channel_map)
                if not lines:
                    return b"", IOResult(exit_code=1)
                return "\n".join(lines).encode(), IOResult()
            except Exception as exc:
                msg = str(exc)
                pushdown_warnings.append(
                    f"discord: native search push-down failed ({msg}); "
                    f"falling back to per-file scan")
                if ("403" in msg or "Forbidden" in msg
                        or "missing access" in msg.lower()):
                    pushdown_warnings.append(
                        "discord: hint - ensure the bot has the "
                        "READ_MESSAGE_HISTORY permission for this guild "
                        "and the MESSAGE CONTENT privileged intent enabled")
                logger.warning(
                    "discord search push-down failed (%s); "
                    "falling back to per-file scan", exc)

        paths = await resolve_glob(accessor, paths, index=index)
        file_prefix = paths[0].prefix if paths else ""
        rd = partial(call_readdir,
                     _readdir,
                     accessor,
                     index=index,
                     prefix=file_prefix)
        st = partial(call_stat,
                     _stat,
                     accessor,
                     index=index,
                     prefix=file_prefix)
        rb = partial(call_read_bytes,
                     discord_read,
                     accessor,
                     index=index,
                     prefix=file_prefix)

        def _stderr_from(*extra: list[str]) -> bytes | None:
            joined: list[str] = list(pushdown_warnings)
            for w in extra:
                joined.extend(w)
            return ("\n".join(joined) + "\n").encode() if joined else None

        if args_l:
            warnings: list[str] = []
            results = await grep_files_only(
                rd,
                st,
                rb,
                paths[0].original,
                pattern,
                recursive=r or R,
                ignore_case=i,
                invert=v,
                line_numbers=n,
                count_only=c,
                fixed_string=F,
                only_matching=o,
                max_count=max_count,
                whole_word=w,
                warnings=warnings,
            )
            stderr = _stderr_from(warnings)
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return ("\n".join(results).encode(), IOResult(stderr=stderr))

        pat = compile_pattern(pattern, i, F, w)

        if len(paths) > 1:
            all_results: list[str] = []
            for p in paths:
                data = (await
                        rb(p.original)).decode(errors="replace").splitlines()
                hits = grep_lines(p.original, data, pat, v, n, c, args_l, o,
                                  max_count)
                if c:
                    if hits:
                        all_results.append(f"{p.original}:{hits[0]}")
                elif args_l:
                    all_results.extend(hits)
                else:
                    all_results.extend(f"{p.original}:{r}" for r in hits)
            stderr = _stderr_from()
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return "\n".join(all_results).encode(), IOResult(stderr=stderr)

        data = await rb(paths[0].original)
        source = yield_bytes(data)
        stream = grep_stream(
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
        stderr = _stderr_from()
        if q:
            io = IOResult(exit_code=1, stderr=stderr)
            return quiet_match(stream, io), io
        io = IOResult(stderr=stderr)
        return exit_on_empty(stream, io), io

    source = _resolve_source(stdin, "grep: usage: grep [flags] pattern [path]")
    pat = compile_pattern(pattern, i, F, w)
    stream = grep_stream(
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
