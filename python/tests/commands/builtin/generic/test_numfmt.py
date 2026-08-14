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

from mirage.commands.builtin.generic.numfmt import numfmt
from mirage.commands.errors import UsageError


async def run(value: str, **kwargs: str | bool) -> str:
    out, _ = await numfmt(value, **kwargs)
    assert out is not None
    return bytes(out).decode().rstrip("\n")


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "from_mode", "expected"), [
    ("1Y", "si", "1000000000000000000000000"),
    ("1Q", "si", "1000000000000000000000000000000"),
    ("1Y", "iec", "1208925819614629174706176"),
    ("1Q", "iec", "1267650600228229401496703205376"),
    ("1.5Y", "si", "1500000000000000000000000"),
    ("1.5Y", "iec", "1813388729421943762059264"),
    ("12345678901234567890123456789", "none", "12345678901234567890123456789"),
])
async def test_to_none_prints_every_digit(value, from_mode, expected):
    # This used to render through a double in TypeScript, which printed
    # '1e+24', and through a 28-digit decimal context in Python, which
    # could not hold 1024**10 at all.
    assert await run(value, from_mode=from_mode) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "expected"), [
    ("1", "1"),
    ("1.000", "1.000"),
    ("1.100", "1.100"),
    ("1.20", "1.20"),
    ("0.10", "0.10"),
    ("00012", "12"),
    ("-1", "-1"),
])
async def test_to_none_keeps_the_precision_it_was_given(value, expected):
    # GNU echoes an unscaled value at the precision it was typed with.
    # Deliberate divergence: GNU reads through a long double, so '1.10'
    # comes back as '1.11' while '1.20' and '1.30' do not.
    assert await run(value) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "expected"), [
    ("1.5K", "1500"),
    ("1.500K", "1500"),
    (".5K", "500"),
    ("1.0005K", "1001"),
    ("1.0000005K", "1001"),
    ("0.0015K", "2"),
    ("1.23456789K", "1235"),
    ("-1.5K", "-1500"),
    ("-0.0015K", "-2"),
])
async def test_a_scaled_value_is_a_whole_number_rounded_away_from_zero(
        value, expected):
    assert await run(value, from_mode="si") == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "from_mode", "expected"), [
    ("1K", "si", "1000"),
    ("1k", "si", "1000"),
    ("1K", "iec", "1024"),
    ("1k", "iec", "1024"),
    ("1Ki", "iec-i", "1024"),
    ("1K", "auto", "1000"),
    ("1Ki", "auto", "1024"),
    ("1ki", "auto", "1024"),
    ("1M", "auto", "1000000"),
    ("1Mi", "auto", "1048576"),
])
async def test_each_from_mode_spells_its_units_its_own_way(
        value, from_mode, expected):
    assert await run(value, from_mode=from_mode) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "from_mode", "message"), [
    ("1KiB", "iec", "numfmt: invalid suffix in input '1KiB': 'iB'"),
    ("1Ki", "iec", "numfmt: invalid suffix in input '1Ki': 'i'"),
    ("1KB", "iec", "numfmt: invalid suffix in input '1KB': 'B'"),
    ("1kB", "si", "numfmt: invalid suffix in input '1kB': 'B'"),
    ("1KiB", "auto", "numfmt: invalid suffix in input '1KiB': 'B'"),
    ("1kI", "auto", "numfmt: invalid suffix in input '1kI': 'I'"),
    ("1KiB", "iec-i", "numfmt: invalid suffix in input '1KiB': 'B'"),
    ("1Z9", "si", "numfmt: invalid suffix in input '1Z9': '9'"),
    ("1Kx", "si", "numfmt: invalid suffix in input '1Kx': 'x'"),
    ("1KK", "si", "numfmt: invalid suffix in input '1KK': 'K'"),
])
async def test_a_unit_followed_by_junk_names_the_junk(value, from_mode,
                                                      message):
    # '1KiB' used to read as a kilobyte in both languages: TypeScript
    # stripped a trailing 'iB' with a regex and Python removed 'i' then 'B'.
    with pytest.raises(UsageError) as exc:
        await run(value, from_mode=from_mode)
    assert str(exc.value) == message
    assert exc.value.exit_code == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "from_mode", "message"), [
    ("1m", "si", "numfmt: invalid suffix in input: '1m'"),
    ("1g", "si", "numfmt: invalid suffix in input: '1g'"),
    ("1J", "si", "numfmt: invalid suffix in input: '1J'"),
    ("1i", "auto", "numfmt: invalid suffix in input: '1i'"),
    ("1i", "iec-i", "numfmt: invalid suffix in input: '1i'"),
    ("1e3", "none", "numfmt: invalid suffix in input: '1e3'"),
    ("0x10", "none", "numfmt: invalid suffix in input: '0x10'"),
    ("1.5.5", "si", "numfmt: invalid suffix in input: '1.5.5'"),
])
async def test_an_unusable_first_character_quotes_only_the_field(
        value, from_mode, message):
    # Only kilo has a lowercase spelling, so '1m' and '1g' are not units;
    # both languages used to upper-case the suffix and accept them.
    with pytest.raises(UsageError) as exc:
        await run(value, from_mode=from_mode)
    assert str(exc.value) == message
    assert exc.value.exit_code == 2


@pytest.mark.asyncio
async def test_iec_i_demands_its_i():
    with pytest.raises(UsageError) as exc:
        await run("1K", from_mode="iec-i")
    assert str(exc.value) == (
        "numfmt: missing 'i' suffix in input: '1K' (e.g Ki/Mi/Gi)")
    assert exc.value.exit_code == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["1K", "1k", "1Ki", "1KiB", "1Kx", "1.5K"])
async def test_a_real_unit_without_from_points_at_from(value):
    with pytest.raises(UsageError) as exc:
        await run(value)
    assert str(exc.value) == (f"numfmt: rejecting suffix in input: '{value}' "
                              "(consider using --from)")
    assert exc.value.exit_code == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "from_mode"), [
    ("abc", "si"),
    ("abc", "none"),
    ("+1", "si"),
    ("1.", "none"),
    ("1.x", "si"),
])
async def test_bad_numbers_report_the_number(value, from_mode):
    # GNU reads no leading '+', no bare trailing '.' and no exponent.
    with pytest.raises(UsageError) as exc:
        await run(value, from_mode=from_mode)
    assert str(exc.value) == f"numfmt: invalid number: '{value}'"
    assert exc.value.exit_code == 2
