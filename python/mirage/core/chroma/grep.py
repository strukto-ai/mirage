from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.grep_helper import compile_pattern, grep_lines
from mirage.commands.builtin.utils.lines import split_lines
from mirage.core.chroma._client import fetch_page_chunks, query_contains
from mirage.core.chroma.path import resolve_path
from mirage.core.chroma.walk import walk
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of, rekey


async def grep_bytes(
    accessor,
    paths: list[PathSpec],
    pattern: str,
    index: IndexCacheStore = NULL_INDEX,
    ignore_case: bool = False,
    invert: bool = False,
    line_numbers: bool = True,
    count_only: bool = False,
    files_only: bool = False,
    whole_word: bool = False,
    fixed_string: bool = False,
    only_matching: bool = False,
    max_count: int | None = None,
) -> tuple[bytes, dict[str, bytes]]:
    """Filename-prefixed grep used by the FUSE ops layer.

    The grep command does not use this; it delegates to the generic
    grep with the same pushdown (see commands/builtin/chroma/grep.py).

    Args:
        accessor: Chroma accessor.
        paths (list[PathSpec]): Files or directories to search.
        pattern (str): Pattern text.
        index (IndexCacheStore): Cache index for path resolution.
        ignore_case (bool): `-i`, case-insensitive matching.
        invert (bool): `-v`, select non-matching lines.
        line_numbers (bool): `-n`, prefix line numbers.
        count_only (bool): `-c`, output match counts.
        files_only (bool): `-l`, output only matching file paths.
        whole_word (bool): `-w`, match whole words.
        fixed_string (bool): `-F`, treat pattern as a literal string.
        only_matching (bool): `-o`, output only matched text.
        max_count (int | None): `-m`, stop after this many matches.

    Returns:
        tuple[bytes, dict[str, bytes]]: Output and per-file reads keyed
            by mount-relative path.
    """
    regex = compile_pattern(pattern, ignore_case, fixed_string, whole_word)
    targets = await target_slugs(accessor, paths, index)
    mount_prefix = mount_prefix_of(paths[0].virtual,
                                   paths[0].resource_path) if paths else ""
    lines: list[str] = []
    reads: dict[str, bytes] = {}
    slug_to_path = {slug: path for path, slug in targets.items()}
    matched_slugs = await coarse_filter_slugs(accessor,
                                              pattern,
                                              targets,
                                              ignore_case=ignore_case,
                                              invert=invert,
                                              fixed_string=fixed_string)
    for slug in matched_slugs:
        content = await fetch_page_chunks(accessor, slug)
        path = slug_to_path.get(slug, "/" + slug)
        data = content.encode()
        reads[PathSpec.from_str_path(path, mount_key(
            path, mount_prefix)).mount_path] = data
        hits = grep_lines(path, split_lines(content), regex, invert,
                          line_numbers, count_only, files_only, only_matching,
                          max_count)
        if count_only:
            if hits:
                lines.append(f"{path}:{hits[0]}")
        elif files_only:
            lines.extend(hits)
        else:
            lines.extend(f"{path}:{hit}" for hit in hits)
    return "\n".join(lines).encode(), reads


async def coarse_filter_slugs(
    accessor,
    pattern: str,
    targets: dict[str, str],
    *,
    ignore_case: bool,
    invert: bool,
    fixed_string: bool,
) -> list[str]:
    candidate_slugs = sorted(targets.values())
    if ignore_case or invert:
        return candidate_slugs
    return await query_contains(accessor,
                                pattern,
                                candidate_slugs,
                                regex=not fixed_string)


async def target_slugs(accessor,
                       paths: list[PathSpec],
                       index: IndexCacheStore = NULL_INDEX) -> dict[str, str]:
    targets: dict[str, str] = {}
    for path in paths:
        resolved = await resolve_path(accessor, path, index)
        if resolved.entry is not None and not resolved.is_dir:
            targets[path.virtual] = str(resolved.entry.extra["slug"])
            continue
        if resolved.is_dir:
            children = await walk(accessor,
                                  path,
                                  index,
                                  include_root=False,
                                  strip_prefix=False)
            for child in children:
                child_spec = PathSpec.from_str_path(
                    child, rekey(path.virtual, path.resource_path, child))
                child_resolved = await resolve_path(accessor, child_spec,
                                                    index)
                if (child_resolved.entry is not None
                        and not child_resolved.is_dir):
                    targets[child] = str(child_resolved.entry.extra["slug"])
    return targets
