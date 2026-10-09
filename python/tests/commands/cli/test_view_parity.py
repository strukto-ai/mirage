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

from dataclasses import fields

from mirage.commands.cli.types import CLIView
from mirage.commands.config import CommandOpts


def test_every_entry_point_is_spelled_as_the_command_tier_spells_it():
    # A CLI leaf and a command handler reach the same planes. Spelling
    # one fact two ways is how the two tiers end up with two
    # vocabularies for one plane, and then with two behaviors.
    view = {f.name: f.type for f in fields(CLIView)}
    opts = {f.name: f.type for f in fields(CommandOpts)}
    missing = sorted(set(view) - set(opts))
    assert not missing, (
        f"CLIView fields absent from CommandOpts: {missing}. "
        "Add the field there under the same name, or name "
        "this one whatever that tier already calls it."
    )
    mismatched = sorted(
        name for name, hint in view.items() if opts[name] != hint
    )
    assert not mismatched, (
        f"CLIView and CommandOpts disagree on the type of: {mismatched}"
    )


def test_every_entry_point_defaults_to_none():
    # None outside a workspace is the whole opt-in: a verb that reads a
    # entry point it was not given has to refuse on its own, and a dispatcher
    # that defaulted to something usable would take that decision away.
    assert all(f.default is None for f in fields(CLIView))
