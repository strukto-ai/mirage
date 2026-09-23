import importlib
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from mirage.commands.config import CommandOpts
from mirage.io.stream import materialize
from mirage.io.types import IOResult
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
    return PathSpec(vfs_path=mount_key(f"/email/{name}", "/email"),
                    virtual=f"/email/{name}",
                    directory=f"/email/{name}")


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
        stdout, io = await _grep_server_side(accessor, "INBOX", "foo", "foo",
                                             _folder())
    # Both matching lines of msg1; msg2 contains no "foo" at all.
    assert await materialize(stdout) == (
        b"/email/INBOX/msg1.email.json:foo foo\n"
        b"/email/INBOX/msg1.email.json:foo bar\n")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_count_flag_defers_to_generic():
    # -c used to run over the search's own candidate list, so a message the
    # IMAP search did not return simply had no row — where GNU prints
    # `path:0` for it. Only the generic scan sees every message.
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    with patch(
            "mirage.commands.builtin.email.grep.search_and_format",
            new=AsyncMock(return_value=[]),
    ) as search, patch(
            "mirage.commands.builtin.email.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.email.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(accessor, [_folder()], ["foo"],
                   CommandOpts(flags={
                       "r": True,
                       "c": True
                   }))
    search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_invert_flag_defers_to_generic():
    # -v reports the lines that do NOT match, so it needs every message —
    # the candidate list is exactly the messages that DO contain the text.
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    with patch(
            "mirage.commands.builtin.email.grep.search_and_format",
            new=AsyncMock(return_value=[]),
    ) as search, patch(
            "mirage.commands.builtin.email.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.email.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(accessor, [_folder()], ["foo"],
                   CommandOpts(flags={
                       "r": True,
                       "v": True
                   }))
    search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_second_folder_operand_defers_to_generic():
    # The push-down answers for one folder, so the second operand used to be
    # dropped in silence: this line reported INBOX and never mentioned Sent.
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    with patch(
            "mirage.commands.builtin.email.grep.search_and_format",
            new=AsyncMock(return_value=[]),
    ) as search, patch(
            "mirage.commands.builtin.email.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.email.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(accessor,
                   [_folder("INBOX"), _folder("Sent")], ["foo"],
                   CommandOpts(flags={"r": True}))
    search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_mount_root_defers_to_generic():
    # The root names no folder, so there is nothing to search: it takes the
    # scan rather than answering for whatever folder came first.
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    root = PathSpec(vfs_path="", virtual="/email", directory="/email")
    with patch(
            "mirage.commands.builtin.email.grep.search_and_format",
            new=AsyncMock(return_value=[]),
    ) as search, patch(
            "mirage.commands.builtin.email.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.email.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(accessor, [root], ["foo"], CommandOpts(flags={"r": True}))
    search.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_grep_alternation_defers_to_generic():
    # IMAP TEXT is a substring search, not a regex engine. Handed
    # `parser|percent` verbatim it looked for that literal, matched nothing,
    # and grep answered exit 1 for a search GNU satisfies twice over. With
    # no literal every match must contain, only the generic scan is
    # faithful (#1067).
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    with patch(
            "mirage.commands.builtin.email.grep.search_and_format",
            new=AsyncMock(return_value=[]),
    ) as search, patch(
            "mirage.commands.builtin.email.grep.resolve_glob",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.email.grep.generic_grep",
            new=AsyncMock(return_value=(b"", IOResult())),
    ) as generic:
        await grep(accessor, [_folder()], ["parser|percent"],
                   CommandOpts(flags={
                       "r": True,
                       "E": True
                   }))
    search.assert_not_awaited()
    generic.assert_awaited_once()


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
    with patch("mirage.commands.builtin.email.grep.search_and_format",
               new=search):
        stdout, io = await grep(accessor, [_folder()], ['budget[^"<]*'],
                                CommandOpts(flags={"r": True}))
    assert search.await_args.args[2] == "budget"
    assert await materialize(
        stdout) == b"/email/INBOX/a.email.json:the budget attached\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_optional_group_narrows_on_the_run_it_requires():
    # `(forecast)?percent` matches a line holding only `percent`, so the
    # optional group's longer run is not the one the server is asked for.
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    pairs = [("/email/INBOX/a.email.json", "disk usage at 91 percent")]
    search = AsyncMock(return_value=pairs)
    with patch("mirage.commands.builtin.email.grep.search_and_format",
               new=search):
        stdout, io = await grep(accessor, [_folder()], ["(forecast)?percent"],
                                CommandOpts(flags={
                                    "r": True,
                                    "E": True
                                }))
    assert search.await_args.args[2] == "percent"
    assert await materialize(
        stdout) == b"/email/INBOX/a.email.json:disk usage at 91 percent\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_reads_a_basic_expression_before_narrowing():
    # Without -E the pattern is a basic expression: `\(...\)\?` is the
    # optional group there, so its run is skipped and `parser` is required.
    accessor = SimpleNamespace(config=SimpleNamespace(max_messages=10))
    pairs = [("/email/INBOX/a.email.json", "yesterday shipped the parser")]
    search = AsyncMock(return_value=pairs)
    with patch("mirage.commands.builtin.email.grep.search_and_format",
               new=search):
        stdout, io = await grep(accessor, [_folder()],
                                [r"the \(brand-new tokenizer or \)\?parser"],
                                CommandOpts(flags={"r": True}))
    assert search.await_args.args[2] == "parser"
    assert await materialize(
        stdout) == b"/email/INBOX/a.email.json:yesterday shipped the parser\n"
    assert io.exit_code == 0
