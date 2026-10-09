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

from mirage.commands.cli.builtin.airtable import AIRTABLE
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.cli.types import CLI
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.types import UsageStyle
from mirage.core.airtable.config import AirtableConfig
from tests.fixtures.airtable_api import FEATURES, OPS, ROADMAP, TOKEN

VERBS = {
    "base": ["list", "get"],
    "table": ["get"],
    "record": ["list", "get", "create", "update", "delete"],
    "comment": ["list", "add"],
}

WRITES = {
    ("record", "create"),
    ("record", "update"),
    ("record", "delete"),
    ("comment", "add"),
}


def leaf(*path: str) -> CLI:
    node = AIRTABLE.spec
    for name in path:
        node = next(c for c in node.subcommands if c.name == name)
    return node


def test_the_tree_is_registered_under_its_name():
    assert cli_spec_for("airtable") is AIRTABLE
    assert AIRTABLE.config_model is AirtableConfig
    assert AIRTABLE.spec.usage_style is UsageStyle.ARGPARSE
    assert {
        g.name: [v.name for v in g.subcommands]
        for g in AIRTABLE.spec.subcommands
    } == VERBS


def test_only_the_writers_are_classified_as_writes():
    for noun, verbs in VERBS.items():
        for verb in verbs:
            assert AIRTABLE.handlers[
                " ".join(
                    (
                        noun,
                        verb,
                    )
                )
            ].write is ((noun, verb) in WRITES)


def test_every_verb_below_base_names_its_base_and_table():
    for noun, verb in [("record", v) for v in VERBS["record"]] + [
        ("comment", "list"),
        ("comment", "add"),
    ]:
        spelled = {
            o.names[-1]
            for o in compile_spec(leaf(noun, verb)).options
            if o.required
        }
        assert spelled == {"--base", "--table"}
    assert [
        o.names[-1] for o in compile_spec(leaf("table", "get")).options
    ] == ["--base"]


@pytest.mark.asyncio
async def test_a_second_install_answers_under_its_own_name(airtable_ws):
    ws = airtable_ws()
    ws.register_cli(
        "work",
        AIRTABLE,
        {
            "token": TOKEN,
            "base_ids": [ROADMAP],
            "requests_per_second": 10_000.0,
        },
    )
    refused = await ws.shell(f"work base get {OPS}")
    assert refused.exit_code == 1
    assert await refused.stderr_str() == (
        f"work base get: {OPS}: Permission denied\n"
    )
    usage = await ws.shell(
        f"work record get --base {ROADMAP} --table {FEATURES}"
    )
    assert usage.exit_code == 2
    assert await usage.stderr_str() == (
        "the following arguments are required: RECORD\n"
    )
    missing = await ws.shell(
        f"work record get --base {ROADMAP} "
        f"--table {FEATURES} recZZZZZZZZZZZZZZ"
    )
    assert missing.exit_code == 1
    assert (await missing.stderr_str()).startswith(
        f"work record get: Airtable API error (GET /{ROADMAP}/"
    )
