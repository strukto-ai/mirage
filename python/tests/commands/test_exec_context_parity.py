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

from mirage.commands.config import CommandOpts, ExecContext

# The dispatcher re-boxes ExecContext onto CommandOpts, so cwd changes
# shape across the seam: the caller supplies the virtual string and
# execute_cmd promotes it to the PathSpec handlers read (the mount
# prefix is not known before the mount is chosen).
_RESHAPED = {"cwd"}


def test_every_context_field_is_spelled_as_command_opts_spells_it():
    # execute_cmd re-boxes the bag onto CommandOpts, so a fact spelled
    # two ways across that seam is two vocabularies for one plane. The
    # mirrored TS pin is the ExecContext mapped type in
    # workspace/mount/mount.test.ts.
    ctx = {
        f.name: f.type
        for f in fields(ExecContext) if f.name != "limit_override"
    }
    opts = {f.name: f.type for f in fields(CommandOpts)}
    missing = sorted(set(ctx) - set(opts))
    assert not missing, (
        f"ExecContext fields absent from CommandOpts: {missing}. "
        "Add the field there under the same name, or name this one "
        "whatever the handler tier already calls it.")
    mismatched = sorted(name for name, hint in ctx.items()
                        if name not in _RESHAPED and opts[name] != hint)
    assert not mismatched, (
        f"ExecContext and CommandOpts disagree on the type "
        f"of: {mismatched}")


def test_session_view_stays_on_both_sides_of_the_seam():
    # No opts reader wants session_view today, but CLIDoors.session_view
    # has production readers (git commit's author identity) and the
    # doors record is pinned to be a subset of CommandOpts — dropping
    # the field here would break that containment, so it stays.
    names = {f.name for f in fields(ExecContext)}
    assert "session_view" in names
    assert "session_view" in {f.name for f in fields(CommandOpts)}
