import json
from typing import Any

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.search import LineMatcher, Searcher, query_matcher
from mirage.core.langfuse.client import (
    fetch_datasets,
    fetch_prompts,
    fetch_sessions,
    fetch_traces,
)
from mirage.core.langfuse.scope import SEARCH_KINDS
from mirage.types import PathSpec
from mirage.vfs.types import SearchQuery, SearchResult


def _filter_traces(
    traces: list[dict[str, Any]], matcher: LineMatcher
) -> list[SearchResult]:
    lines: list[SearchResult] = []
    for t in traces:
        trace_id = t.get("id", "")
        line_json = json.dumps(t, ensure_ascii=False, separators=(",", ":"))
        if not matcher(line_json):
            continue
        lines.append(
            (
                PathSpec.from_str_path(f"/traces/{trace_id}.json"),
                f"traces/{trace_id}.json:{line_json}",
            )
        )
    return lines


def _filter_sessions(
    sessions: list[dict[str, Any]], matcher: LineMatcher
) -> list[SearchResult]:
    lines: list[SearchResult] = []
    for s in sessions:
        session_id = s.get("id", "")
        if not matcher(session_id):
            continue
        line_json = json.dumps(s, ensure_ascii=False, separators=(",", ":"))
        lines.append(
            (
                PathSpec.from_str_path(f"/sessions/{session_id}"),
                f"sessions/{session_id}:{line_json}",
            )
        )
    return lines


def _filter_prompts(
    prompts: list[dict[str, Any]], matcher: LineMatcher
) -> list[SearchResult]:
    lines: list[SearchResult] = []
    seen: set[str] = set()
    for p in prompts:
        prompt_name = p.get("name", "")
        if prompt_name in seen:
            continue
        if not matcher(prompt_name):
            continue
        seen.add(prompt_name)
        line_json = json.dumps(p, ensure_ascii=False, separators=(",", ":"))
        lines.append(
            (
                PathSpec.from_str_path(f"/prompts/{prompt_name}"),
                f"prompts/{prompt_name}:{line_json}",
            )
        )
    return lines


def _filter_datasets(
    datasets: list[dict[str, Any]], matcher: LineMatcher
) -> list[SearchResult]:
    lines: list[SearchResult] = []
    for d in datasets:
        dataset_name = d.get("name", "")
        if not matcher(dataset_name):
            continue
        line_json = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
        lines.append(
            (
                PathSpec.from_str_path(f"/datasets/{dataset_name}"),
                f"datasets/{dataset_name}:{line_json}",
            )
        )
    return lines


# The search push-down answers from the list endpoints (one call instead
# of one read per entry), so it greps listing summaries: a pattern that
# only occurs in a trace's observation bodies needs a file read to match.
async def _traces_searcher(
    accessor: LangfuseAccessor, match: ScopeMatch, query: SearchQuery
) -> list[SearchResult]:
    traces = await fetch_traces(
        accessor.api, limit=accessor.config.default_search_limit
    )
    return _filter_traces(traces, query_matcher(query))


async def _sessions_searcher(
    accessor: LangfuseAccessor, match: ScopeMatch, query: SearchQuery
) -> list[SearchResult]:
    sessions = await fetch_sessions(
        accessor.api, limit=accessor.config.default_search_limit
    )
    return _filter_sessions(sessions, query_matcher(query))


async def _prompts_searcher(
    accessor: LangfuseAccessor, match: ScopeMatch, query: SearchQuery
) -> list[SearchResult]:
    return _filter_prompts(
        await fetch_prompts(accessor.api), query_matcher(query)
    )


async def _datasets_searcher(
    accessor: LangfuseAccessor, match: ScopeMatch, query: SearchQuery
) -> list[SearchResult]:
    return _filter_datasets(
        await fetch_datasets(accessor.api), query_matcher(query)
    )


_CONTAINERS: dict[str, Searcher[LangfuseAccessor]] = {
    "traces": _traces_searcher,
    "sessions": _sessions_searcher,
    "prompts": _prompts_searcher,
    "datasets": _datasets_searcher,
}

SEARCHERS: dict[str, Searcher[LangfuseAccessor]] = {
    kind: _CONTAINERS[container] for kind, container in SEARCH_KINDS.items()
}
