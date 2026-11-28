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

import asyncio

import pytest

from mirage.core.slack.search import (
    MAX_PAGES,
    _search_facts,
    search_messages,
)
from tests.fixtures.slack_workspace import (
    AUTH,
    LISTING,
    SEARCH_FILES,
    SEARCH_MESSAGES,
    SEARCHER,
    USER_TOKEN,
    USERS,
    SlackWorkspace,
)

UNTIL_CLEARED = 1_000_000


@pytest.mark.asyncio
async def test_search_messages_defaults_include_page_1(slack_workspace):
    await search_messages(slack_workspace.accessor(), "hello")
    [params] = await slack_workspace.run.params("GET", SEARCH_MESSAGES)
    assert params == {
        "query": "hello",
        "count": "20",
        "page": "1",
        "sort": "timestamp",
    }


@pytest.mark.asyncio
async def test_search_messages_forwards_explicit_count_and_page(
    slack_workspace,
):
    await search_messages(slack_workspace.accessor(), "hello", 50, 3)
    [params] = await slack_workspace.run.params("GET", SEARCH_MESSAGES)
    assert (params["count"], params["page"]) == ("50", "3")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, reads",
    [
        (
            "grep -rlw deploy /slack/channels",
            ["C1/2025-11-03", "C1/2025-11-06", "C2/2025-11-04"],
        ),
        ("grep -rlw rocket /slack/channels/general__C1", ["C1/2025-11-04"]),
        ("grep -rlw Launch /slack/channels/general__C1", ["C1/2025-11-05"]),
        (
            "grep -rlw Launch /slack/channels",
            ["C1/2025-11-05", "C2/2025-11-07"],
        ),
        (
            "grep -rlw deploy /slack",
            [
                "C1/2025-11-03",
                "C1/2025-11-06",
                "C2/2025-11-04",
                "D1/2025-11-03",
            ],
        ),
        ("grep -rlw deploy /slack/dms", ["D1/2025-11-03"]),
        ("rg -lw deploy /slack/dms/ana__D1", ["D1/2025-11-03"]),
    ],
)
async def test_a_word_reads_only_the_days_search_names(slack, line, reads):
    # A file hit names every day a message shares it, not its upload:
    # plan.txt is uploaded in general on 2025-11-05 and shared again in
    # random on 2025-11-07.
    full = await slack(line, walk_limit=-1)
    out, code, read, _ = await slack(line)
    assert (out, code) == full[:2]
    assert read == reads


@pytest.mark.asyncio
async def test_a_day_is_read_rather_than_searched(slack, slack_workspace):
    line = "grep -rlw deploy /slack/channels/general__C1/2025-11-06"
    full = await slack(line, walk_limit=-1)
    out, code, read, searches = await slack(line)
    assert (out, code, read) == full[:3]
    assert (searches, await slack_workspace.count(USERS)) == ([], 0)


@pytest.mark.asyncio
async def test_the_patterns_of_one_grep_share_one_user_listing(
    slack, slack_workspace
):
    line = "grep -rlw -e deploy -e lunch /slack/channels"
    await slack(line, search_token=SEARCHER)
    assert (
        await slack_workspace.count(USERS),
        await slack_workspace.count(LISTING, token=SEARCHER),
    ) == (1, 1)


@pytest.mark.asyncio
async def test_a_stopped_search_stops_its_user_listing(slack_workspace):
    # The first pattern fetches in its own task, so stopping it stops the
    # listing; a pattern waiting on it reads every day instead. The user
    # listing is held at the fake until the first is stopped, and a
    # listing left running would go on to ask for the workspace URL.
    listing = asyncio.Event()
    stopped = asyncio.Event()

    async def hold() -> None:
        listing.set()
        await stopped.wait()

    await slack_workspace.run.before_next([("GET", USERS)], hold)
    accessor = slack_workspace.accessor()
    first = asyncio.create_task(_search_facts(accessor))
    await listing.wait()
    second = asyncio.create_task(_search_facts(accessor))
    await asyncio.sleep(0)
    first.cancel()
    assert await second is None
    await asyncio.wait([first])
    assert first.cancelled()
    stopped.set()
    await asyncio.gather(*slack_workspace.run.changes)
    assert accessor.search_facts is None
    assert await slack_workspace.count(AUTH) == 0
    await accessor.close()


@pytest.mark.asyncio
async def test_a_channel_is_searched_by_name_and_reactions_too(slack):
    *_, searches = await slack("grep -rlw rocket /slack/channels/general__C1")
    assert searches == [
        "in:#general rocket",
        "in:#general ocket",
        "in:#general rocket",
        "in:#general ocket",
        "in:#general has::rocket:",
    ]


async def _own_answer(workspace: SlackWorkspace, route: str, query: str):
    return await workspace.run.call(
        "GET",
        route,
        params={"query": query},
        headers={"Authorization": f"Bearer {USER_TOKEN}"},
    )


async def _as_is(workspace: SlackWorkspace) -> None:
    return None


async def _too_many_pages(workspace: SlackWorkspace) -> None:
    # Slack's own answer, its page count past what Mirage reads.
    page = await _own_answer(workspace, SEARCH_MESSAGES, "deploy")
    page["messages"]["paging"]["pages"] = MAX_PAGES + 1
    await workspace.run.answer_next(
        "GET", SEARCH_MESSAGES, 200, page, times=UNTIL_CLEARED
    )


async def _on_its_own_domain(workspace: SlackWorkspace) -> None:
    # A real workspace's URL is on its own domain, whose words a file's
    # permalink carries; the fake answers with its own origin.
    await workspace.answer_auth(url="https://acme.slack.com/")


async def _files_without_shares(workspace: SlackWorkspace) -> None:
    page = await _own_answer(workspace, SEARCH_FILES, "Launch")
    for match in page["files"]["matches"]:
        del match["shares"]
    await workspace.run.answer_next(
        "GET", SEARCH_FILES, 200, page, times=UNTIL_CLEARED
    )


async def _refused(workspace: SlackWorkspace) -> None:
    for route in (SEARCH_MESSAGES, SEARCH_FILES):
        await workspace.run.answer_next(
            "GET",
            route,
            200,
            {"ok": False, "error": "ratelimited"},
            times=UNTIL_CLEARED,
        )


async def _reset(workspace: SlackWorkspace) -> None:
    for route in (SEARCH_MESSAGES, SEARCH_FILES):
        await workspace.run.answer_next(
            "GET", route, None, times=UNTIL_CLEARED
        )


async def _slow(workspace: SlackWorkspace) -> None:
    for route in (SEARCH_MESSAGES, SEARCH_FILES):
        await workspace.run.answer_next(
            "GET", route, 200, times=UNTIL_CLEARED, delay_ms=2_000
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, arrange, config",
    [
        ("grep -rlw text /slack/channels", _as_is, {}),
        ("grep -rlw Lima /slack/channels", _as_is, {}),
        ("grep -rlw nothing /slack/channels", _as_is, {}),
        ("grep -rlw deploy /slack/channels", _too_many_pages, {}),
        ("grep -rlw acme /slack/channels", _on_its_own_domain, {}),
        ("grep -rlw Launch /slack/channels", _files_without_shares, {}),
        ("grep -rlw deploy /slack/channels", _refused, {}),
        ("grep -rlw deploy /slack/channels", _reset, {}),
        ("grep -rlw deploy /slack/channels", _slow, {"timeout": 0.5}),
    ],
)
async def test_every_day_is_read_when_search_cannot_answer(
    slack, slack_workspace, line, arrange, config
):
    full = await slack(line, walk_limit=-1)
    await arrange(slack_workspace)
    out, code, read, _ = await slack(line, **config)
    assert (out, code, read) == full[:3]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "grep -rlw deploy /slack/channels",
        "rg -lw deploy /slack/channels/random__C2",
    ],
)
async def test_a_channel_the_search_user_is_not_in_is_read(slack, line):
    # random is private and the search token's user (ben) is not in it,
    # so no search names its days; ruling them out would miss its deploy.
    full = await slack(line, walk_limit=-1)
    out, code, read, _ = await slack(line, search_token=SEARCHER)
    assert (out, code, read) == full[:3]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["grep -rlw deploy /slack", "grep -rlw deploy /slack/dms"]
)
async def test_a_dm_the_search_user_is_not_in_is_read(slack, line):
    # The listing's token holds a DM the search token's user is not in
    # (ana's, which ben cannot see), so no search names its days.
    full = await slack(line, walk_limit=-1)
    out, code, read, _ = await slack(line, search_token=SEARCHER)
    assert (out, code, read) == full[:3]
