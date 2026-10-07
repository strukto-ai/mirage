import importlib
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from mirage.commands.builtin.email.io import IO as BACKEND_IO
from mirage.commands.config import CommandOpts
from mirage.io.stream import materialize
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

sys.modules.setdefault(
    "aioimaplib",
    SimpleNamespace(IMAP4=object, IMAP4_SSL=object),
)
sys.modules.setdefault(
    "aiosmtplib",
    SimpleNamespace(SMTP=object, send=AsyncMock()),
)

_email_grep = importlib.import_module("mirage.commands.builtin.email.grep")
_grep_server_side = _email_grep._grep_server_side
grep = _email_grep.grep


def _folder(name: str = "INBOX") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(f"/email/{name}", "/email"),
        virtual=f"/email/{name}",
        directory=f"/email/{name}",
    )


@pytest.mark.asyncio
async def test_grep_server_side_matches_real_lines():
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    pairs = [
        ("/email/INBOX/msg1.email.json", "foo foo\nfoo bar\nbaz\n"),
        ("/email/INBOX/msg2.email.json", "bar\nbaz\n"),
    ]
    with patch(
        "mirage.commands.builtin.email.grep.search_and_format",
        new=AsyncMock(return_value=pairs),
    ):
        stdout, io = await _grep_server_side(
            accessor, "INBOX", "foo", "foo", _folder()
        )
    # Both matching lines of msg1; msg2 contains no "foo" at all.
    assert await materialize(stdout) == (
        b"/email/INBOX/msg1.email.json:foo foo\n"
        b"/email/INBOX/msg1.email.json:foo bar\n"
    )
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_regex_narrows_on_its_required_literal():
    # The server is asked for the literal every match must contain, and the
    # real regex runs locally over each candidate. A candidate the
    # case-insensitive substring search returns but the regex rejects
    # contributes nothing.
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    pairs = [
        ("/email/INBOX/a.email.json", "the budget attached"),
        ("/email/INBOX/b.email.json", "Q2 Budget Review"),
    ]
    search = AsyncMock(return_value=pairs)
    with patch(
        "mirage.commands.builtin.email.grep.search_and_format", new=search
    ):
        stdout, io = await grep(
            BACKEND_IO,
            accessor,
            [_folder()],
            ['budget[^"<]*'],
            CommandOpts(flags={"r": True}),
        )
    assert search.await_args.args[2] == "budget"
    assert (
        await materialize(stdout)
        == b"/email/INBOX/a.email.json:the budget attached\n"
    )
    assert io.exit_code == 0
