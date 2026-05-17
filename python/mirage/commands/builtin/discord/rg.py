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

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import compile_pattern, grep_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
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
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def _collect_files(
    accessor: DiscordAccessor,
    path: PathSpec,
    index: IndexCacheStore | None,
) -> list[str]:
    try:
        children = await _readdir(accessor, path, index)
    except FileNotFoundError:
        return []
    files: list[str] = []
    for child in children:
        if child.endswith(".json") or child.endswith(".jsonl"):
            files.append(child)
        else:
            child_spec = PathSpec(original=child,
                                  directory=child,
                                  resolved=False,
                                  prefix=path.prefix)
            files.extend(await _collect_files(accessor, child_spec, index))
    return files


@command("rg", resource="discord", spec=SPECS["rg"])
async def rg(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    o: bool = False,
    m: str | None = None,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    hidden: bool = False,
    type: str | None = None,
    glob: str | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("rg: usage: rg [flags] pattern [path]")
    pattern_str = texts[0]
    max_count = int(m) if m is not None else None
    pat = compile_pattern(pattern_str, i, F, w)

    pushdown_warnings: list[str] = []
    if paths:
        scope = await detect_scope(paths[0], index)
        if scope.level in ("messages", "file_blob", "date"):
            coalesced = await coalesce_scopes(paths, index)
            if coalesced is not None:
                scope = coalesced

        if scope.level == "root":
            return b"", IOResult(exit_code=1,
                                 stderr=b"rg: root-level search "
                                 b"not yet supported\n")

        if scope.level in ("channel", "guild"):
            try:
                if scope.guild_id is None:
                    raise RuntimeError("cannot resolve guild ID")
                msgs = await search_guild(
                    accessor.config,
                    scope.guild_id,
                    pattern_str,
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
        blob_paths: list[str] = []
        file_prefix = paths[0].prefix if paths else ""
        for path_item in paths:
            blob_paths.extend(await _collect_files(accessor, path_item, index))
        blob_paths = sorted(set(blob_paths))
        all_results: list[str] = []
        any_match = False
        for bp in blob_paths:
            if not hidden and any(
                    part.startswith(".") for part in bp.split("/")):
                continue
            try:
                bp_spec = PathSpec(original=bp,
                                   directory=bp,
                                   resolved=True,
                                   prefix=file_prefix)
                data = await discord_read(accessor, bp_spec, index)
            except (FileNotFoundError, IsADirectoryError, RuntimeError):
                continue
            text = data.decode(errors="replace")
            if not text:
                continue
            lines = text.splitlines()
            matched = grep_lines(bp,
                                 lines,
                                 pat,
                                 invert=v,
                                 line_numbers=n,
                                 count_only=c,
                                 files_only=args_l,
                                 only_matching=o,
                                 max_count=max_count)
            if not matched:
                continue
            any_match = True
            if args_l:
                all_results.append(bp)
                continue
            if c:
                all_results.append(f"{bp}:{len(matched)}")
                continue
            for line in matched:
                all_results.append(f"{bp}:{line}")
        stderr = (("\n".join(pushdown_warnings) +
                   "\n").encode() if pushdown_warnings else None)
        if not any_match:
            return b"", IOResult(exit_code=1, stderr=stderr)
        return "\n".join(all_results).encode(), IOResult(stderr=stderr)

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("rg: usage: rg [flags] pattern path")
    lines = raw.decode(errors="replace").splitlines()
    matched = grep_lines("<stdin>",
                         lines,
                         pat,
                         invert=v,
                         line_numbers=n,
                         count_only=c,
                         files_only=args_l,
                         only_matching=o,
                         max_count=max_count)
    if not matched:
        return b"", IOResult(exit_code=1)
    if c:
        return str(len(matched)).encode(), IOResult()
    result_lines: list[str] = []
    for line in matched:
        result_lines.append(line)
    return "\n".join(result_lines).encode(), IOResult()
