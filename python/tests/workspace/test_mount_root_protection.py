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
"""Mount-root protection tests.

Covers two related behaviors enforced by the command dispatcher
(`mirage/workspace/executor/command.py`):

1. **Write rule** — destructive/conflicting commands targeting a mount
   root (`rm /r2`, `mv /r2 /x`, `mkdir /r2`, `touch /r2`, `ln s /r2`)
   are refused with Unix-style error messages, instead of silently
   modifying the underlying resource.

2. **Read fan-out** — traversal commands (`find`, `tree`, `du`,
   `grep -r`, `ls -R`) on a path at or above mount roots run across
   each affected mount and concatenate output, so users see
   contents from every mount instead of only the parent's resource.

Together these make mount roots behave like first-class directories
that the user can navigate but not accidentally destroy.
"""
import asyncio

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace

# ── fixtures ──────────────────────────────────────


def _ws_two_mounts() -> Workspace:
    return Workspace({
        "/r2": (RAMResource(), MountMode.WRITE),
        "/ram": (RAMResource(), MountMode.WRITE),
    })


def _ws_nested() -> Workspace:
    return Workspace({
        "/data": (RAMResource(), MountMode.WRITE),
        "/data/inner": (RAMResource(), MountMode.WRITE),
    })


async def _exec(ws: Workspace, cmd: str):
    return await ws.execute(cmd)


def _run(coro):
    return asyncio.run(coro)


# ════════════════════════════════════════════════════════════════════
# Write rule
# ════════════════════════════════════════════════════════════════════

# ── rm ─────────────────────────────────────────────


def test_rm_refuses_mount_root():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "rm /r2")
        assert r.exit_code == 1
        assert b"Device or resource busy" in (r.stderr or b"")
        assert b"/r2" in (r.stderr or b"")

    _run(go())


def test_rmdir_refuses_mount_root():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "rmdir /r2")
        assert r.exit_code == 1
        assert b"Device or resource busy" in (r.stderr or b"")
        assert b"/r2" in (r.stderr or b"")

    _run(go())


def test_rm_rf_refuses_mount_root():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "rm -rf /r2")
        assert r.exit_code == 1
        assert b"Device or resource busy" in (r.stderr or b"")

    _run(go())


def test_rm_rf_refuses_mount_root_with_trailing_slash():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "rm -rf /r2/")
        assert r.exit_code == 1
        assert b"Device or resource busy" in (r.stderr or b"")

    _run(go())


def test_rm_inside_mount_still_works():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "touch /r2/file")
        r = await _exec(ws, "rm /r2/file")
        assert r.exit_code == 0

    _run(go())


def test_rm_rf_inside_mount_still_works():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "mkdir /r2/sub")
        await _exec(ws, "touch /r2/sub/x")
        r = await _exec(ws, "rm -rf /r2/sub")
        assert r.exit_code == 0

    _run(go())


def test_rm_does_not_remove_mount_after_refusal():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "touch /r2/keep")
        r = await _exec(ws, "rm -rf /r2")
        assert r.exit_code == 1
        # Mount is still mounted and contents preserved.
        ls = await _exec(ws, "ls /r2")
        assert b"keep" in (ls.stdout or b"")

    _run(go())


# ── mv ─────────────────────────────────────────────


def test_mv_refuses_mount_root_as_source():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "mv /r2 /elsewhere")
        assert r.exit_code == 1
        assert b"Device or resource busy" in (r.stderr or b"")

    _run(go())


def test_mv_into_mount_root_is_allowed():
    # `mv /src /r2` means "move /src INTO /r2" when /r2 is a directory.
    # The guard only fires on the SOURCE being a mount root.
    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "touch /ram/payload")
        r = await _exec(ws, "mv /ram/payload /r2/payload")
        assert r.exit_code == 0

    _run(go())


# ── mkdir ──────────────────────────────────────────


def test_mkdir_refuses_existing_mount_root():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "mkdir /r2")
        assert r.exit_code == 1
        assert b"File exists" in (r.stderr or b"")

    _run(go())


def test_mkdir_dash_p_on_mount_root_is_idempotent():
    # GNU mkdir -p does not error if the directory already exists.
    # Mount roots already exist, so -p must succeed silently.
    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "mkdir -p /r2")
        assert r.exit_code == 0
        assert (r.stderr or b"") == b""

    _run(go())


def test_mkdir_inside_mount_is_allowed():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "mkdir /r2/newdir")
        assert r.exit_code == 0

    _run(go())


# ── touch ─────────────────────────────────────────


def test_touch_refuses_mount_root():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "touch /r2")
        assert r.exit_code == 1
        assert b"Is a directory" in (r.stderr or b"")

    _run(go())


def test_touch_inside_mount_is_allowed():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "touch /r2/newfile")
        assert r.exit_code == 0

    _run(go())


# ── ln ────────────────────────────────────────────


def test_ln_refuses_mount_root_as_link_name():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "touch /ram/source")
        r = await _exec(ws, "ln /ram/source /r2")
        assert r.exit_code == 1
        assert b"File exists" in (r.stderr or b"")

    _run(go())


def test_ln_s_refuses_mount_root_as_link_name():

    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "ln -s /ram/source /r2")
        assert r.exit_code == 1
        assert b"File exists" in (r.stderr or b"")

    _run(go())


def test_ln_inside_a_single_mount_is_not_blocked_by_guard():
    # ln within one mount should not be refused by the mount-root guard.
    # (Whether the underlying resource supports ln is a separate concern;
    # the guard's job is only to reject mount-root targets.)
    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "touch /r2/source")
        r = await _exec(ws, "ln -s /r2/source /r2/link")
        # Either ln succeeds, or the resource doesn't support it. The
        # guard's "File exists" message must NOT appear because /r2/link
        # is not a mount root.
        assert b"File exists" not in (r.stderr or b"")

    _run(go())


# ── nested mount as a target ──────────────────────


def test_rm_refuses_nested_mount_root():

    async def go():
        ws = _ws_nested()
        r = await _exec(ws, "rm -rf /data/inner")
        assert r.exit_code == 1
        assert b"Device or resource busy" in (r.stderr or b"")

    _run(go())


def test_rm_inside_nested_mount_still_works():

    async def go():
        ws = _ws_nested()
        await _exec(ws, "touch /data/inner/x")
        r = await _exec(ws, "rm /data/inner/x")
        assert r.exit_code == 0

    _run(go())


def test_rm_inside_outer_mount_still_works():

    async def go():
        ws = _ws_nested()
        await _exec(ws, "touch /data/outer-file")
        r = await _exec(ws, "rm /data/outer-file")
        assert r.exit_code == 0

    _run(go())


# ════════════════════════════════════════════════════════════════════
# Read fan-out
# ════════════════════════════════════════════════════════════════════


def test_find_root_lists_mounts_at_depth_one():
    # The original user-reported bug: `find / -maxdepth 1 -mindepth 1
    # -type d` should list mount prefixes as directories.
    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "find / -maxdepth 1 -mindepth 1 -type d")
        assert r.exit_code == 0
        out = (r.stdout or b"").decode()
        assert "/r2" in out
        assert "/ram" in out

    _run(go())


def test_find_root_descends_into_each_mount():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "touch /r2/a")
        await _exec(ws, "touch /ram/b")
        r = await _exec(ws, "find /")
        out = (r.stdout or b"").decode()
        assert "/r2/a" in out
        assert "/ram/b" in out

    _run(go())


def test_find_inside_one_mount_is_unchanged():
    # When the path is inside a single mount with no descendants,
    # fan-out does NOT trigger and the command behaves normally.
    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "touch /r2/only-a")
        r = await _exec(ws, "find /r2")
        out = (r.stdout or b"").decode()
        assert "/r2/only-a" in out
        # Must not contain entries from /ram
        assert "/ram" not in out

    _run(go())


def test_find_with_no_descendants_does_not_fan_out():
    # Single mount; no descendants under /. Fan-out path must not run.
    async def go():
        ws = Workspace({"/r2": (RAMResource(), MountMode.WRITE)})
        await _exec(ws, "touch /r2/file")
        r = await _exec(ws, "find /r2")
        assert r.exit_code == 0
        out = (r.stdout or b"").decode()
        assert "/r2/file" in out

    _run(go())


def test_find_root_with_nested_mounts():
    # Both /data and /data/inner are mounts. find / must surface
    # files from both.
    async def go():
        ws = _ws_nested()
        await _exec(ws, "touch /data/outer-file")
        await _exec(ws, "touch /data/inner/inner-file")
        r = await _exec(ws, "find /")
        out = (r.stdout or b"").decode()
        assert "/data/outer-file" in out
        assert "/data/inner/inner-file" in out

    _run(go())


def test_find_filters_parent_paths_under_descendant_mount():
    # If the parent mount has a key whose path overlaps a descendant
    # mount's prefix, the descendant mount's content is authoritative.
    # The parent's shadowed content must not duplicate into the
    # output under the descendant prefix.
    async def go():
        ws = _ws_nested()
        # Put a key in the parent /data resource that lives at the
        # SAME path as the /data/inner mount root.
        await _exec(ws, "mkdir /data/inner"
                    )  # blocked: /data/inner is a mount root → File exists
        # Instead, write under the inner mount and verify no parent leak.
        await _exec(ws, "touch /data/inner/from-inner")
        r = await _exec(ws, "find /data")
        out = (r.stdout or b"").decode()
        # /data/inner/from-inner exists from the inner mount.
        assert "/data/inner/from-inner" in out

    _run(go())


def test_find_maxdepth_skips_too_deep_mount():
    # /data/inner is at depth 2 from /. With -maxdepth 1, the inner
    # mount must NOT be included.
    async def go():
        ws = _ws_nested()
        await _exec(ws, "touch /data/inner/x")
        await _exec(ws, "touch /data/outer-file")
        r = await _exec(ws, "find / -maxdepth 1")
        out = (r.stdout or b"").decode()
        # /data should appear (depth 1)
        assert "/data" in out
        # /data/inner/x and /data/outer-file are too deep
        assert "/data/inner/x" not in out

    _run(go())


def test_grep_recursive_root_fans_out():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "sh -c 'echo needle > /r2/a.txt'")
        await _exec(ws, "sh -c 'echo other > /ram/b.txt'")
        await _exec(ws, "sh -c 'echo needle > /ram/c.txt'")
        r = await _exec(ws, "grep -r needle /")
        out = (r.stdout or b"").decode()
        assert "/r2/a.txt" in out
        assert "/ram/c.txt" in out
        assert "/ram/b.txt" not in out

    _run(go())


def test_du_root_fans_out():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "sh -c 'echo content > /r2/file'")
        await _exec(ws, "sh -c 'echo other > /ram/file'")
        r = await _exec(ws, "du /")
        out = (r.stdout or b"").decode()
        # Each mount contributes some line containing its prefix.
        assert "/r2" in out
        assert "/ram" in out

    _run(go())


# ── ls / unchanged ────────────────────────────────


def test_ls_root_still_lists_mounts():
    # The pre-existing ls injection path must still work — mounts
    # are visible as folder entries in `ls /`.
    async def go():
        ws = _ws_two_mounts()
        r = await _exec(ws, "ls /")
        out = (r.stdout or b"").decode()
        assert "r2" in out
        assert "ram" in out

    _run(go())


# ════════════════════════════════════════════════════════════════════
# rm safety flags: accepted no-ops given mirage's structural protection
# (non-interactive; mount roots unremovable; recursion never crosses a
# mount boundary).
# ════════════════════════════════════════════════════════════════════


def test_rm_interactive_flags_are_accepted_noops():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "touch /r2/a /r2/b")
        assert (await _exec(ws, "rm -I /r2/a")).exit_code == 0
        assert (await _exec(ws, "rm -i /r2/b")).exit_code == 0
        ls = await _exec(ws, "ls /r2")
        assert (ls.stdout or b"").strip() == b""

    _run(go())


def test_rm_one_file_system_removes_within_mount():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "mkdir -p /r2/d")
        await _exec(ws, "touch /r2/d/x")
        r = await _exec(ws, "rm --one-file-system -rf /r2/d")
        assert r.exit_code == 0
        ls = await _exec(ws, "ls /r2")
        assert (ls.stdout or b"").strip() == b""

    _run(go())


def test_rm_no_preserve_root_still_cannot_remove_mount_root():
    # mirage protection is structural: --no-preserve-root does not disable it.
    async def go():
        ws = _ws_two_mounts()
        for cmd in ("rm --preserve-root -rf /",
                    "rm --no-preserve-root -rf /r2"):
            r = await _exec(ws, cmd)
            assert r.exit_code == 1
            assert b"Device or resource busy" in (r.stderr or b"")

    _run(go())


def test_rm_capital_i_not_invalid_option():

    async def go():
        ws = _ws_two_mounts()
        await _exec(ws, "touch /r2/a")
        r = await _exec(ws, "rm -rfI /r2/a")
        assert r.exit_code == 0
        assert b"invalid option" not in (r.stderr or b"")

    _run(go())
