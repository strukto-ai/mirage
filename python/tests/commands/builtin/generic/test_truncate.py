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

import pytest

from mirage.commands.builtin.generic.truncate import (
    TruncateFlags,
    parse_size,
    truncate_generic,
)
from mirage.commands.errors import UsageError
from mirage.types import FileStat, FileType, PathSpec


def test_plain_and_operation_sizes():
    assert parse_size("10", 0) == 10
    assert parse_size("%4", 10) == 12


def test_full_gnu_suffix_alphabet():
    # truncate's letter set is not split's: lowercase g/k/m/t are valid
    # (pinned against coreutils 9.7), and E/P parse fine even though most
    # filesystems refuse the resulting size.
    assert parse_size("1k", 0) == 1024
    assert parse_size("1g", 0) == 1024**3
    assert parse_size("1t", 0) == 1024**4
    assert parse_size("1G", 0) == 1024**3
    assert parse_size("1GiB", 0) == 1024**3
    assert parse_size("1GB", 0) == 1000**3
    assert parse_size("1mB", 0) == 1000**2
    assert parse_size("1E", 0) == 1024**6


def test_whitespace_skipped_around_the_mode_character():
    # GNU skips C-locale whitespace both before and after the mode char,
    # so ` 4` is absolute, ` +4` extends, and `< 4` caps (pinned against
    # coreutils 9.7).
    assert parse_size(" +4", 10) == 14
    assert parse_size("\t<\t4", 10) == 4


@pytest.mark.parametrize("value", ["<+4", "<\t+4"])
def test_sign_after_mode_is_multiple_relative_modifiers(value):
    # A sign after <, >, / or % is refused as a second relative modifier
    # before the number is read, not reported as an invalid number.
    with pytest.raises(UsageError) as exc:
        parse_size(value, 10)
    assert str(exc.value) == (
        "truncate: multiple relative modifiers "
        "specified\nTry 'truncate --help' for more "
        "information."
    )
    assert exc.value.exit_code == 1


@pytest.mark.parametrize(
    ("value", "quoted"),
    [
        ("<abc", "abc"),
        ("4\t", "4\\t"),
    ],
)
def test_junk_is_invalid_number(value, quoted):
    # The digits must follow the sign immediately: no second sign, no gap,
    # and no trailing whitespace. GNU quotes the remainder past the skipped
    # whitespace and mode character, sign included, and escapes it.
    with pytest.raises(UsageError) as exc:
        parse_size(value, 0)
    assert str(exc.value) == f"truncate: Invalid number: '{quoted}'"
    assert exc.value.exit_code == 1


def test_off_t_bound_is_asymmetric():
    # off_t is signed: 2**63 is one too large upward but fine downward.
    assert parse_size("8191P", 0) == 8191 * 1024**5
    assert parse_size("-8E", 10) == 0
    assert parse_size("-9223372036854775808", 10) == 0
    with pytest.raises(UsageError) as exc:
        parse_size("8E", 0)
    assert str(exc.value) == (
        "truncate: Invalid number: '8E': Value too large for defined data type"
    )
    with pytest.raises(UsageError):
        parse_size("9223372036854775808", 0)


def test_division_by_zero():
    with pytest.raises(UsageError) as exc:
        parse_size("/0", 10)
    assert str(exc.value) == "truncate: division by zero"


def _operand(path: str, raw: str) -> PathSpec:
    return PathSpec(
        virtual=path, directory="/", vfs_path=path.strip("/"), raw_path=raw
    )


@pytest.mark.asyncio
async def test_a_slashed_operand_is_the_opens_eisdir():
    # GNU opens with O_CREAT before it stats, so `missing/` and `reg/` are
    # the open's EISDIR, not the stat's miss, and an absent bare name is
    # made where its directory exists. The EISDIR is settled before the
    # op, so a backend with no truncate op says it too. The chain answers
    # first: under an absent directory the name is ENOENT and the op never
    # runs, every operand is still tried, and -c leaves an absent name
    # alone.
    lengths: list[tuple[str, int]] = []

    async def stat(path):
        raise FileNotFoundError(path.virtual)

    async def truncate_fn(path, length, no_create) -> None:
        lengths.append((path.raw_path, length))

    _, io = await truncate_generic(
        [
            _operand("/missing", "/missing/"),
            _operand("/nodir/x", "/nodir/x"),
            _operand("/missing", "/missing"),
        ],
        flags=TruncateFlags(size="4", no_create=False),
        stat=stat,
        truncate_fn=truncate_fn,
    )
    assert lengths == [("/missing", 4)]
    assert io.exit_code == 1
    assert io.stderr == (
        b"truncate: cannot open '/missing/' for writing: Is a directory\n"
        b"truncate: cannot open '/nodir/x' for writing: "
        b"No such file or directory\n"
    )
    _, io = await truncate_generic(
        [_operand("/missing", "/missing")],
        flags=TruncateFlags(size="4", no_create=True),
        stat=stat,
        truncate_fn=truncate_fn,
    )
    assert io.exit_code == 0
    assert lengths == [("/missing", 4)]


@pytest.mark.asyncio
async def test_no_create_reaches_the_mutation_after_a_successful_stat():
    calls = []

    async def stat(path):
        calls.append("stat")
        return FileStat(name=path.virtual, type=FileType.FILE, size=4)

    async def mutate(path, length, no_create):
        calls.append((path.virtual, length, no_create))

    _, result = await truncate_generic(
        [PathSpec.from_str_path("/file")],
        flags=TruncateFlags("2", True),
        stat=stat,
        truncate_fn=mutate,
    )
    assert result.exit_code == 0
    assert calls == ["stat", ("/file", 2, True)]
