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

from mirage.commands.cli.types import CLIDoors
from mirage.commands.config import CommandOpts


def test_every_door_is_spelled_as_the_command_tier_spells_it():
    # A CLI leaf and a command handler reach the same planes. Spelling
    # one fact two ways is how the two tiers end up with two
    # vocabularies for one plane, and then with two behaviors.
    doors = {f.name: f.type for f in fields(CLIDoors)}
    opts = {f.name: f.type for f in fields(CommandOpts)}
    missing = sorted(set(doors) - set(opts))
    assert not missing, (
        f"CLIDoors fields absent from CommandOpts: {missing}. "
        "Add the field there under the same name, or name "
        "this one whatever that tier already calls it.")
    mismatched = sorted(name for name, hint in doors.items()
                        if opts[name] != hint)
    assert not mismatched, (f"CLIDoors and CommandOpts disagree on the type "
                            f"of: {mismatched}")


def test_every_door_defaults_to_none():
    # None outside a workspace is the whole opt-in: a verb that reads a
    # door it was not given has to refuse on its own, and a door that
    # defaulted to something usable would take that decision away.
    assert all(f.default is None for f in fields(CLIDoors))
