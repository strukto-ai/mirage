import pytest

from mirage.workspace.executor.builtins.text import handle_echo


async def echo_bytes(args: list[str]) -> bytes:
    out, io, _ = await handle_echo(args)
    assert io.exit_code == 0
    assert isinstance(out, bytes)
    return out


@pytest.mark.asyncio
async def test_plain_words_join_with_newline():
    assert await echo_bytes(["hi", "there"]) == b"hi there\n"


@pytest.mark.asyncio
async def test_leading_n_suppresses_newline():
    assert await echo_bytes(["-n", "hi"]) == b"hi"


@pytest.mark.asyncio
async def test_trailing_n_prints_literally():
    assert await echo_bytes(["hi", "-n"]) == b"hi -n\n"


@pytest.mark.asyncio
async def test_cluster_ne():
    assert await echo_bytes(["-ne", "a\\tb"]) == b"a\tb"


@pytest.mark.asyncio
async def test_capital_e_disables_escapes():
    assert await echo_bytes(["-e", "-E", "a\\tb"]) == b"a\\tb\n"


@pytest.mark.asyncio
async def test_last_of_e_and_E_wins_within_cluster():
    assert await echo_bytes(["-eE", "a\\tb"]) == b"a\\tb\n"
    assert await echo_bytes(["-Ee", "a\\tb"]) == b"a\tb\n"


@pytest.mark.asyncio
async def test_unknown_char_makes_word_literal():
    assert await echo_bytes(["-nq", "hi"]) == b"-nq hi\n"


@pytest.mark.asyncio
async def test_option_after_operand_is_literal():
    assert await echo_bytes(["hi", "-e", "a\\tb"]) == b"hi -e a\\tb\n"


@pytest.mark.asyncio
async def test_lone_dash_is_literal():
    assert await echo_bytes(["-"]) == b"-\n"
