import pytest

from mirage.commands.config import Context, _answer_standard_options
from mirage.commands.spec import SPECS
from mirage.commands.spec.help import render_help
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.types import CommandSpec
from mirage.io.types import materialize


async def _noop(accessor, paths, texts, ctx):
    return None


async def _help_of(name, spec) -> str:
    _, wrapped = _answer_standard_options(name, spec, _noop)
    result = await wrapped(None, [], [], Context(flags={"help": True}))
    assert result is not None
    return (await materialize(result[0])).decode()


def test_every_synopsis_names_a_builtin_and_starts_with_it():
    for name, line in SYNOPSES.items():
        assert name in SPECS
        assert line.split(" ", 1)[0] == name
        assert not line.startswith("Usage:")


def test_a_synopsis_replaces_the_synthesized_line():
    assert "Usage: grep [OPTION]... PATTERNS [FILE]...\n" in render_help(
        "grep", SPECS["grep"], synopsis=SYNOPSES["grep"]
    )
    assert "Usage: grep [flags]" in render_help("grep", SPECS["grep"])


@pytest.mark.asyncio
async def test_help_support_hands_the_builtin_its_synopsis():
    assert "Usage: grep [OPTION]... PATTERNS [FILE]...\n" in await _help_of(
        "grep", SPECS["grep"]
    )


@pytest.mark.asyncio
async def test_a_registered_command_borrowing_a_listed_name_keeps_its_line():
    # The synopsis is chosen at registration, only for the builtin's own
    # spec object, so a custom `grep` renders what its spec says.
    rendered = await _help_of("grep", CommandSpec())
    assert "Usage: grep" in rendered
    assert "PATTERNS" not in rendered
