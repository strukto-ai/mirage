import logging
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Protocol

from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               keep, start_basename,
                                               tree_has_empty)
from mirage.core.nextcloud.search import (Bounds, FilesSearchQuery,
                                          SearchEntry, search_files,
                                          supports_query)
from mirage.types import FindType, PathSpec

logger = logging.getLogger(__name__)


class _EntryMetadata(Protocol):

    @property
    def mode(self) -> EntryMode:
        ...

    @property
    def content_length(self) -> int:
        ...

    @property
    def last_modified(self) -> datetime | None:
        ...


@dataclass(frozen=True, slots=True)
class _FindScope:
    base_key: str
    scan_key: str
    start_name: str

    @classmethod
    def from_path(cls, path: PathSpec) -> "_FindScope":
        relative = path.mount_path.strip("/")
        base_key = "/" + relative if relative else "/"
        scan_key = relative + "/" if relative else "/"
        return cls(base_key=base_key,
                   scan_key=scan_key,
                   start_name=start_basename(path))

    def contains(self, key: str) -> bool:
        if self.base_key == "/":
            return key.startswith("/")
        return key == self.base_key or key.startswith(self.base_key + "/")

    def depth(self, key: str) -> int:
        if key == self.base_key:
            return 0
        base_depth = 0 if self.base_key == "/" else self.base_key.count("/")
        return key.count("/") - base_depth

    def parent_keys(self, key: str) -> list[str]:
        keys: list[str] = []
        parent = key.rsplit("/", 1)[0] or "/"
        while self.contains(parent):
            keys.append(parent)
            if parent == self.base_key:
                break
            parent = parent.rsplit("/", 1)[0] or "/"
        return keys


@dataclass(frozen=True, slots=True)
class _Candidate:
    key: str
    name: str
    kind: FindType
    size: int | None
    modified: float | None
    is_empty: bool | None = None

    @property
    def is_directory(self) -> bool:
        return self.kind == FindType.DIRECTORY


@dataclass(frozen=True, slots=True)
class _FindCriteria:
    predicate: PredNode
    size: Bounds[int]
    modified: Bounds[float]
    min_depth: int | None
    max_depth: int | None

    @property
    def needs_modified(self) -> bool:
        return self.modified.constrained

    def search_query(self) -> FilesSearchQuery:
        return FilesSearchQuery(
            tree=self.predicate,
            size=self.size,
            modified=self.modified,
        )


def _basename(key: str) -> str:
    return key.rstrip("/").rsplit("/", 1)[-1]


def _candidate_from_metadata(key: str, name: str,
                             metadata: _EntryMetadata) -> _Candidate:
    is_dir = metadata.mode == EntryMode.Dir
    modified = (metadata.last_modified.timestamp()
                if metadata.last_modified is not None else None)
    return _Candidate(
        key=key,
        name=name,
        kind=FindType.DIRECTORY if is_dir else FindType.FILE,
        size=0 if is_dir else metadata.content_length,
        modified=modified,
    )


def _candidate_from_search(entry: SearchEntry) -> _Candidate:
    return _Candidate(
        key=entry.key,
        name=entry.name,
        kind=entry.kind,
        size=entry.size,
        modified=entry.modified,
    )


async def _stat_candidate(
    accessor: NextcloudAccessor,
    key: str,
    name: str,
) -> _Candidate | None:
    operator = accessor.operator()
    if key == "/":
        try:
            metadata = await operator.stat("/")
        except NotFound:
            return _Candidate(key="/",
                              name=name,
                              kind=FindType.DIRECTORY,
                              size=0,
                              modified=None)
        return _candidate_from_metadata("/", name, metadata)
    relative = key.strip("/")
    try:
        metadata = await operator.stat(relative)
    except NotFound:
        try:
            metadata = await operator.stat(relative + "/")
        except NotFound:
            return None
    return _candidate_from_metadata(key, name, metadata)


def _matches(candidate: _Candidate, scope: _FindScope,
             criteria: _FindCriteria) -> bool:
    if not scope.contains(candidate.key):
        raise ValueError(
            f"Nextcloud Files Search out-of-scope path: {candidate.key}")
    depth = scope.depth(candidate.key)
    if criteria.max_depth is not None and depth > criteria.max_depth:
        return False
    entry = FindEntry(
        key=candidate.key,
        name=candidate.name,
        kind=candidate.kind,
        depth=depth,
        is_empty=candidate.is_empty,
    )
    if not keep(entry, criteria.predicate, criteria.min_depth):
        return False
    if criteria.size.constrained:
        size = 0 if candidate.is_directory else (candidate.size or 0)
        if not criteria.size.contains(size):
            return False
    if criteria.modified.constrained:
        if (candidate.modified is None
                or not criteria.modified.contains(candidate.modified)):
            return False
    return True


def _matching_keys(entries: dict[str, _Candidate], scope: _FindScope,
                   criteria: _FindCriteria) -> list[str]:
    return sorted(candidate.key for candidate in entries.values()
                  if _matches(candidate, scope, criteria))


async def _find_with_search(
    accessor: NextcloudAccessor,
    path: PathSpec,
    scope: _FindScope,
    criteria: _FindCriteria,
) -> list[str] | None:
    if criteria.max_depth == 0 and not tree_has_empty(criteria.predicate):
        start = await _stat_candidate(accessor, scope.base_key,
                                      scope.start_name)
        if start is None:
            return []
        return _matching_keys({scope.base_key: start}, scope, criteria)
    query = criteria.search_query()
    if not supports_query(query):
        return None
    start = await _stat_candidate(accessor, scope.base_key, scope.start_name)
    if start is None:
        return []
    if not start.is_directory:
        return None
    entries = {scope.base_key: start}
    if criteria.max_depth != 0:
        found = await search_files(accessor, path, query)
        if found is None:
            return None
        for entry in found:
            entries.setdefault(entry.key, _candidate_from_search(entry))
    return _matching_keys(entries, scope, criteria)


def _scan_key(raw_key: str) -> str:
    return "/" + raw_key.rstrip("/").lstrip("/")


def _directory_candidate(key: str) -> _Candidate:
    return _Candidate(key=key,
                      name=_basename(key),
                      kind=FindType.DIRECTORY,
                      size=0,
                      modified=None)


async def _collect_scan_candidates(
    accessor: NextcloudAccessor,
    scope: _FindScope,
) -> tuple[dict[str, _Candidate], set[str]]:
    candidates: dict[str, _Candidate] = {}
    nonempty_directories: set[str] = set()
    operator = accessor.operator()
    try:
        async for raw_entry in await operator.scan(scope.scan_key):
            raw_key = raw_entry.path
            if not raw_key:
                continue
            key = _scan_key(raw_key)
            candidates[key] = _candidate_from_metadata(
                key,
                _basename(key),
                raw_entry.metadata,
            )
            for parent_key in scope.parent_keys(key):
                nonempty_directories.add(parent_key)
                candidates.setdefault(parent_key,
                                      _directory_candidate(parent_key))
    except NotFound as exc:
        logger.debug("Nextcloud scan path not found: %s",
                     scope.scan_key,
                     exc_info=exc)
    return candidates, nonempty_directories


def _empty_state(candidate: _Candidate,
                 nonempty_directories: set[str]) -> bool:
    if candidate.is_directory:
        return candidate.key not in nonempty_directories
    return (candidate.size or 0) == 0


async def _hydrate_scan_candidate(
    accessor: NextcloudAccessor,
    candidate: _Candidate,
    nonempty_directories: set[str],
    criteria: _FindCriteria,
) -> _Candidate:
    hydrated = candidate
    if (criteria.needs_modified and candidate.is_directory
            and candidate.modified is None):
        stat = await _stat_candidate(accessor, candidate.key, candidate.name)
        if stat is not None:
            hydrated = stat
    return replace(
        hydrated,
        is_empty=_empty_state(hydrated, nonempty_directories),
    )


async def _find_with_scan(
    accessor: NextcloudAccessor,
    scope: _FindScope,
    criteria: _FindCriteria,
) -> list[str]:
    candidates, nonempty_directories = await _collect_scan_candidates(
        accessor, scope)
    start = await _stat_candidate(accessor, scope.base_key, scope.start_name)
    if start is None:
        return []
    candidates[scope.base_key] = start
    hydrated: dict[str, _Candidate] = {}
    for candidate in candidates.values():
        hydrated[candidate.key] = await _hydrate_scan_candidate(
            accessor,
            candidate,
            nonempty_directories,
            criteria,
        )
    return _matching_keys(hydrated, scope, criteria)


async def find(
    accessor: NextcloudAccessor,
    path: PathSpec,
    name: str | None = None,
    type: FindType | str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    mtime_min: float | None = None,
    mtime_max: float | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
    empty: bool = False,
    tree: PredNode | None = None,
) -> list[str]:
    predicate = tree if tree is not None else build_tree(
        name=name,
        iname=iname,
        path_pattern=path_pattern,
        type=type,
        name_exclude=name_exclude,
        or_names=or_names,
        empty=empty,
    )
    scope = _FindScope.from_path(path)
    criteria = _FindCriteria(
        predicate=predicate,
        size=Bounds[int](lower=min_size, upper=max_size),
        modified=Bounds[float](lower=mtime_min, upper=mtime_max),
        min_depth=mindepth,
        max_depth=maxdepth,
    )
    search_results = await _find_with_search(accessor, path, scope, criteria)
    if search_results is not None:
        return search_results
    return await _find_with_scan(accessor, scope, criteria)
