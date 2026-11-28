import pytest

from mirage.core.discord.paginate import after_id_pages
from tests.fixtures.discord_guild import GENERAL, GUILD, MEMBERS, MESSAGES


@pytest.mark.asyncio
async def test_after_id_pages_advances_with_newest_id_on_newest_first(
    discord_guild,
):
    # Discord answers GET /channels/{id}/messages newest-first, so the cursor
    # is the first item; taking the last one would re-request the same window.
    # Two a page: files and hello, then morning.
    out = []
    async for page in after_id_pages(
        discord_guild.accessor(),
        f"/channels/{GENERAL}/messages",
        base_params={},
        last_id_fn=lambda m: m["id"],
        page_size=2,
        newest_first=True,
    ):
        out.append(page)
    contents = [m["content"] for page in out for m in page]
    assert contents == ["files", "hello", "morning"]
    files = out[0][0]["id"]
    asked = await discord_guild.run.params("GET", MESSAGES)
    assert [p["after"] for p in asked] == ["0", files]


@pytest.mark.asyncio
async def test_after_id_pages_advances_with_last_id_by_default(discord_guild):
    # Members and guilds come back ascending, so the newest id is the last.
    out = []
    async for page in after_id_pages(
        discord_guild.accessor(),
        f"/guilds/{GUILD}/members",
        base_params={},
        last_id_fn=lambda m: m["user"]["id"],
        page_size=2,
    ):
        out.append(page)
    assert [m["user"]["id"] for page in out for m in page] == [
        "311",
        "312",
        "911",
    ]
    asked = await discord_guild.run.params("GET", MEMBERS)
    assert [p["after"] for p in asked] == ["0", "312"]
