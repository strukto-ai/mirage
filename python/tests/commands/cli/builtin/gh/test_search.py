from unittest.mock import AsyncMock

import pytest

from mirage.accessor.github import GitHubAccount
from mirage.commands.cli.builtin.gh.search import search_cmd, search_spec
from mirage.commands.config import Context
from mirage.core.github.client import GitHubApiError
from mirage.core.github.config import GhConfig

URL = "https://api.example.test/search/issues?q=needle+type%3Aissue"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,flags,expected",
    [
        (
            "issues",
            {
                "label": ["bug,help wanted"],
                "repo": ["integ/a", "other/b"],
                "locked": "false",
                "no_assignee": True,
            },
            '"two words" is:unlocked label:"help wanted" label:bug '
            "no:assignee repo:integ/a repo:other/b type:issue",
        ),
        (
            "prs",
            {
                "app": "bot",
                "review_requested": "integ/team",
                "merged": "false",
                "draft": True,
            },
            '"two words" author:app/bot draft:true is:unmerged '
            "team-review-requested:integ/team type:pr",
        ),
        (
            "repos",
            {
                "owner": ["integ,other"],
                "include_forks": "only",
                "number_topics": ">2",
            },
            '"two words" fork:only topics:>2 user:integ user:other',
        ),
        (
            "code",
            {"match": ["file"], "extension": "ts", "repo": ["integ/a"]},
            '"two words" extension:ts in:file repo:integ/a',
        ),
        (
            "commits",
            {
                "author_name": "A Person",
                "merge": "false",
                "visibility": ["public"],
            },
            '"two words" author-name:"A Person" is:public merge:false',
        ),
    ],
)
async def test_search_qualifiers_match_native_gh(
    monkeypatch, kind, flags, expected
):
    fetch = AsyncMock(return_value=[])
    monkeypatch.setitem(search_cmd.__globals__, "search", fetch)
    leaf = next(
        item for item in search_spec().subcommands if item.name == kind
    )
    await search_cmd(
        kind,
        GitHubAccount(GhConfig(token="t")),
        [],
        ["two words"],
        Context(
            argv=("search", kind, "two words"),
            flags={**flags, "limit": "30", "json": "url"},
            spec=leaf,
        ),
    )
    assert fetch.await_args.args[2] == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,message,body,stderr",
    [
        (
            422,
            "Validation Failed",
            '{"message":"Validation Failed","errors":[{"message":"bad repo"}]}',
            'Invalid search query "needle type:issue".\nbad repo\n',
        ),
        (
            422,
            "Validation Failed",
            '{"message":"Validation Failed","errors":[{"code":"x"}]}',
            'Invalid search query "needle type:issue".\n\n',
        ),
        (
            422,
            "Validation Failed",
            '{"message":"Validation Failed"}',
            f"HTTP 422: Validation Failed ({URL})\n",
        ),
        (500, "Internal Server Error", '{"foo":1}', f"HTTP 500:  ({URL})\n"),
        (
            502,
            "Bad Gateway",
            "upstream unavailable\n",
            f"HTTP 502: 502 Bad Gateway ({URL})\n",
        ),
    ],
)
async def test_search_failure_reads_as_gh_words_it(
    monkeypatch, status, message, body, stderr
):
    fetch = AsyncMock(
        side_effect=GitHubApiError(message, status, body=body, url=URL)
    )
    monkeypatch.setitem(search_cmd.__globals__, "search", fetch)
    leaf = next(
        item for item in search_spec().subcommands if item.name == "issues"
    )
    out, io = await search_cmd(
        "issues",
        GitHubAccount(GhConfig(token="t")),
        [],
        ["needle"],
        Context(
            argv=("search", "issues", "needle"),
            flags={"limit": "30"},
            spec=leaf,
        ),
    )
    assert out is None
    assert io.exit_code == 1
    assert await io.stderr_str() == stderr
