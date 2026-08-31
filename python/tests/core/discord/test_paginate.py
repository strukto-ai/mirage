import pytest

from mirage.core.discord.paginate import after_id_pages


class _Recorder:

    def __init__(self, pages):
        self.pages = pages
        self.afters = []


@pytest.mark.asyncio
async def test_after_id_pages_advances_with_newest_id_on_newest_first(
        monkeypatch):
    # Discord answers GET /channels/{id}/messages newest-first, so the cursor
    # is the first item; taking the last one would re-request the same window.
    calls: list[str] = []
    pages = {
        "0": [{
            "id": str(200 - i)
        } for i in range(2)],
        "200": [{
            "id": "300"
        }],
    }

    async def fake_get(config, endpoint, params=None, session=None):
        calls.append(str(params["after"]))
        return pages.get(str(params["after"]), [])

    monkeypatch.setattr("mirage.core.discord.paginate.discord_get", fake_get)
    out = []
    async for page in after_id_pages(None,
                                     "/channels/C/messages",
                                     base_params={},
                                     last_id_fn=lambda m: m["id"],
                                     page_size=2,
                                     newest_first=True):
        out.append(page)
    assert calls == ["0", "200"]
    assert [m["id"] for page in out for m in page] == ["200", "199", "300"]


@pytest.mark.asyncio
async def test_after_id_pages_advances_with_last_id_by_default(monkeypatch):
    # Members and guilds come back ascending, so the newest id is the last.
    calls: list[str] = []
    pages = {"0": [{"id": "1"}, {"id": "2"}], "2": [{"id": "3"}]}

    async def fake_get(config, endpoint, params=None, session=None):
        calls.append(str(params["after"]))
        return pages.get(str(params["after"]), [])

    monkeypatch.setattr("mirage.core.discord.paginate.discord_get", fake_get)
    out = []
    async for page in after_id_pages(None,
                                     "/guilds/G/members",
                                     base_params={},
                                     last_id_fn=lambda m: m["id"],
                                     page_size=2):
        out.append(page)
    assert calls == ["0", "2"]
    assert [m["id"] for page in out for m in page] == ["1", "2", "3"]
