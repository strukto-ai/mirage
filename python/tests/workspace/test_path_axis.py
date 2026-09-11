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

import asyncio
import errno

from mirage.context import reset_current_session, set_current_session
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace

CARVE_PROFILE = {
    "mounts": {
        "/repo": "r"
    },
    "paths": {
        "hide": ["/repo"],
        "show": {
            "/repo/public": "r"
        }
    },
}


def _seeded(mode: MountMode = MountMode.WRITE) -> Workspace:
    ws = Workspace({"/repo": (RAMResource(), mode)}, mode=MountMode.WRITE)

    async def seed():
        io = await ws.execute(
            "mkdir -p /repo/secrets /repo/public/docs && "
            "printf 'hello repo\\n' > /repo/README.md && "
            "printf 'PRIVATE needle\\n' > /repo/secrets/key.pem && "
            "printf '<h1>needle</h1>\\n' > /repo/public/index.html && "
            "printf 'docs needle\\n' > /repo/public/docs/a.txt")
        assert io.exit_code == 0, io.stderr

    asyncio.run(seed())
    return ws


def _carved() -> Workspace:
    ws = _seeded()
    ws.create_session("rev", profile=CARVE_PROFILE)
    return ws


def _run(ws: Workspace, line: str):

    async def go():
        return await ws.execute(line, session_id="rev")

    return asyncio.run(go())


def test_a_deeper_show_reopens_its_subtree():
    ws = _carved()
    ok = _run(ws, "cat /repo/public/index.html")
    assert ok.exit_code == 0 and b"needle" in (ok.stdout or b"")
    denied = _run(ws, "cat /repo/secrets/key.pem")
    assert denied.exit_code != 0
    assert (denied.stderr or b"") == (
        b"cat: /repo/secrets/key.pem: No such file or directory\n")


def test_every_enumeration_surface_agrees_on_the_carve_out():
    # One tree probed through ls, globs, find, grep -r and du: the same
    # predicate answers all of them, and this battery is what holds the
    # surfaces together if one grows its own filter.
    ws = _carved()
    listed = _run(ws, "ls /repo")
    assert (listed.stdout or b"").split() == [b"public"]
    globbed = _run(ws, "echo /repo/*")
    assert (globbed.stdout or b"") == b"/repo/public\n"
    found = _run(ws, "find /repo")
    assert (found.stdout or b"") == (b"/repo\n"
                                     b"/repo/public\n"
                                     b"/repo/public/docs\n"
                                     b"/repo/public/docs/a.txt\n"
                                     b"/repo/public/index.html\n")
    grepped = _run(ws, "grep -rl needle /repo")
    hits = sorted((grepped.stdout or b"").splitlines())
    assert hits == [b"/repo/public/docs/a.txt", b"/repo/public/index.html"]
    sized = _run(ws, "du -a /repo")
    du_paths = [
        line.split(b"\t")[1] for line in (sized.stdout or b"").splitlines()
    ]
    assert b"/repo/secrets/key.pem" not in du_paths
    assert b"/repo/public/index.html" in du_paths


def test_the_road_to_the_carve_out_exists():
    # `/repo` itself lies under the hide, but a visible show anchors
    # below it, so the directory stays traversable and lists only the
    # carve-out.
    ws = _carved()
    walked = _run(ws, "cd /repo && ls")
    assert walked.exit_code == 0
    assert (walked.stdout or b"").split() == [b"public"]
    stat_ok = _run(ws, "test -d /repo/public && echo yes")
    assert (stat_ok.stdout or b"") == b"yes\n"
    stat_gone = _run(ws, "test -e /repo/secrets || echo gone")
    assert (stat_gone.stdout or b"") == b"gone\n"


def test_hide_speaks_before_the_mode():
    # Creating into hidden space answers EACCES (a silent success would
    # leave a file the session cannot see, and ENOENT would invite a
    # retry); the mode never speaks about a path the session cannot
    # see, so no refusal leaks that the region is read-only.
    ws = _carved()
    create = _run(ws, "echo x > /repo/secrets/new.txt")
    assert (create.stderr
            or b"") == b"/repo/secrets/new.txt: Permission denied\n"
    clobber = _run(ws, "echo x > /repo/secrets/key.pem")
    assert (clobber.stderr
            or b"") == b"/repo/secrets/key.pem: Permission denied\n"


def test_a_write_below_the_mode_reads_read_only_file_system():
    ws = _carved()
    refused = _run(ws, "echo x > /repo/public/new.txt")
    assert refused.exit_code != 0
    assert (refused.stderr
            or b"") == b"/repo/public/new.txt: Read-only file system\n"


def test_a_deeper_show_mode_refines_the_mount_cap():
    # mounts: {/repo: r} + show {"/repo/build": rw}: the deeper entry
    # wins below its anchor, the mount cap holds everywhere else, and
    # the whole-mount write command gate lets the line reach the op
    # door instead of refusing the command outright.
    ws = _seeded()
    ws.create_session("rev",
                      profile={
                          "mounts": {
                              "/repo": "r"
                          },
                          "paths": {
                              "show": {
                                  "/repo/build": "rw"
                              }
                          },
                      })
    ok = _run(
        ws, "mkdir /repo/build && echo out > /repo/build/a.txt && "
        "cat /repo/build/a.txt")
    assert ok.exit_code == 0, ok.stderr
    assert (ok.stdout or b"") == b"out\n"
    held = _run(ws, "echo x > /repo/README.md")
    assert (held.stderr or b"") == b"/repo/README.md: Read-only file system\n"


def test_a_show_mode_never_grants_past_the_configured_mode():
    # The mount's own mode stays the strongest answer possible: a show
    # stating rw on a READ-configured mount changes nothing.
    ws = Workspace({"/repo": (RAMResource(), MountMode.READ)})
    ws.create_session("rev",
                      profile={"paths": {
                          "show": {
                              "/repo/build": "rw"
                          }
                      }})
    refused = _run(ws, "echo x > /repo/build/a.txt")
    assert refused.exit_code != 0
    assert (refused.stderr
            or b"") == b"/repo/build/a.txt: Read-only file system\n"


def test_a_show_without_a_covering_hide_restricts_nothing():
    # 12.3b: show is a carve-out and a mode statement, never an
    # allowlist; a path outside every show entry stays visible.
    ws = _seeded()
    ws.create_session("rev",
                      profile={"paths": {
                          "show": {
                              "/repo/public": "r"
                          }
                      }})
    ok = _run(ws, "cat /repo/README.md")
    assert ok.exit_code == 0 and b"hello" in (ok.stdout or b"")


def test_scripts_run_only_from_an_x_region():
    # x per script path: the show grants rwx below one subtree, so a
    # script there runs and the same interpreter refuses one outside
    # it, in file-operand voice, exit 126.
    ws = _seeded(MountMode.EXEC)
    ws.create_session("rev",
                      profile={
                          "mounts": {
                              "/repo": "r"
                          },
                          "paths": {
                              "show": {
                                  "/repo/tools": "rwx"
                              }
                          },
                      })
    seeded = _run(
        ws, "mkdir /repo/tools && echo 'print(\"ran\")' > /repo/tools/go.py")
    assert seeded.exit_code == 0, seeded.stderr
    ran = _run(ws, "python3 /repo/tools/go.py")
    assert ran.exit_code == 0 and (ran.stdout or b"") == b"ran\n"
    outside = _run(ws, "python3 /repo/public/index.html")
    assert outside.exit_code == 126
    assert (outside.stderr
            or b"") == b"python3: /repo/public/index.html: not in EXEC mode\n"


def test_inline_permissions_cannot_add_show():
    ws = Workspace({"/repo": RAMResource()})
    try:
        ws.create_session("rev",
                          profile=CARVE_PROFILE,
                          permissions={"paths": {
                              "show": ["/repo/secrets"]
                          }})
    except Exception as exc:
        assert "not show entries" in str(exc)
    else:
        raise AssertionError("inline show was accepted")


def test_the_write_gate_holds_per_path_inside_an_admitted_command():
    # The command gate admits mkdir because one region grants writes;
    # each write the handler then makes still answers for its own
    # region, so the whole-mount admission opens no side door.
    ws = _seeded()
    ws.create_session("rev",
                      profile={
                          "mounts": {
                              "/repo": "r"
                          },
                          "paths": {
                              "show": {
                                  "/repo/build": "rw"
                              }
                          },
                      })
    ok = _run(ws, "mkdir /repo/build")
    assert ok.exit_code == 0, ok.stderr
    held = _run(ws, "mkdir /repo/probe")
    assert held.exit_code != 0
    assert b"Read-only file system" in (held.stderr or b"")
    removed = _run(ws, "rm /repo/README.md")
    assert removed.exit_code != 0
    assert b"Read-only file system" in (removed.stderr or b"")
    assert _run(ws, "cat /repo/README.md").exit_code == 0
    # Copying OUT of the read-only region is a read plus a write into
    # the granted one, both allowed; moving back mutates a read-only
    # endpoint and is refused.
    copied = _run(ws, "cp /repo/README.md /repo/build/copy.md")
    assert copied.exit_code == 0, copied.stderr
    moved = _run(ws, "mv /repo/build/copy.md /repo/copy.md")
    assert moved.exit_code != 0
    assert b"Read-only file system" in (moved.stderr or b"")


def test_a_subtree_mutation_answers_for_the_regions_below_it():
    # A native rm -r or a directory rename covers everything below its
    # operand in one backend call, so a read-only carve-out below the
    # operand refuses the whole op up front rather than being deleted
    # past the per-path check.
    ws = _seeded()

    async def grow():
        io = await ws.execute("mkdir -p /repo/tree/locked && "
                              "printf 'kept\\n' > /repo/tree/locked/f.txt && "
                              "printf 'open\\n' > /repo/tree/open.txt")
        assert io.exit_code == 0, io.stderr

    asyncio.run(grow())
    ws.create_session("rev",
                      profile={
                          "paths": {
                              "show": {
                                  "/repo/tree/locked": "r"
                              }
                          },
                      })
    held = _run(ws, "rm -r /repo/tree")
    assert held.exit_code != 0
    assert (held.stderr or b"") == (
        b"rm: cannot remove '/repo/tree/locked': Read-only file system\n")
    assert _run(ws, "cat /repo/tree/locked/f.txt").exit_code == 0
    assert _run(ws, "cat /repo/tree/open.txt").exit_code == 0
    moved = _run(ws, "mv /repo/tree /repo/moved")
    assert moved.exit_code != 0
    assert b"Read-only file system" in (moved.stderr or b"")
    assert _run(ws, "cat /repo/tree/locked/f.txt").exit_code == 0
    # A subtree with no carve-out below still mutates freely.
    ok = _run(ws, "rm -r /repo/public")
    assert ok.exit_code == 0, ok.stderr


def test_a_globbed_show_reopens_and_stays_walkable():
    # The carve-out spelled as a pattern: the anchor directory the glob
    # exposes children of stays traversable, so the road to the matches
    # exists.
    ws = _seeded()
    ws.create_session("rev",
                      profile={
                          "mounts": {
                              "/repo": "r"
                          },
                          "paths": {
                              "hide": ["/repo"],
                              "show": ["/repo/public/*"]
                          },
                      })
    walked = _run(ws, "ls /repo")
    assert (walked.stdout or b"").split() == [b"public"]
    listed = _run(ws, "ls /repo/public")
    assert listed.exit_code == 0
    found = _run(ws, "find /repo -type f")
    out = (found.stdout or b"").splitlines()
    assert b"/repo/public/index.html" in out
    assert b"/repo/secrets/key.pem" not in out


def test_a_fork_carries_the_carve_out():
    # A subshell forks the session; the axis rides INHERITED_FIELDS, so
    # the fork answers exactly like its parent.
    ws = _carved()
    forked = _run(ws, "(cat /repo/secrets/key.pem)")
    assert forked.exit_code != 0
    assert b"No such file or directory" in (forked.stderr or b"")
    ok = _run(ws, "(cat /repo/public/index.html)")
    assert ok.exit_code == 0


def _boxed(profile: dict) -> Workspace:
    ws = Workspace({"/repo": RAMResource()}, mode=MountMode.WRITE)

    async def seed():
        io = await ws.execute("mkdir -p /repo/box/sec /repo/only && "
                              "printf 'v\\n' > /repo/box/a.txt && "
                              "printf 's\\n' > /repo/box/sec/k && "
                              "printf 't\\n' > /repo/box/x.tkn && "
                              "printf 'h\\n' > /repo/only/h")
        assert io.exit_code == 0, io.stderr

    asyncio.run(seed())
    ws.create_session("rev", profile=profile)
    return ws


def _host(ws: Workspace, line: str):

    async def go():
        return await ws.execute(line)

    return asyncio.run(go())


def test_mv_that_would_reveal_hidden_content_refuses():
    # The hide anchors at /repo/box/sec; the move would re-anchor its
    # content to /repo/moved/sec, which nothing hides, so it refuses in
    # GNU's permission-denied voice and the source stays whole.
    ws = _boxed({"paths": {"hide": ["/repo/box/sec"]}})
    refused = _run(ws, "mv /repo/box /repo/moved")
    assert refused.exit_code == 1
    assert (refused.stderr or b"") == (
        b"mv: cannot move '/repo/box' to '/repo/moved': Permission denied\n")
    intact = _host(ws, "test -e /repo/box/sec/k")
    assert intact.exit_code == 0


def test_mv_rides_a_component_pattern_hide_along():
    # *.tkn follows the name wherever the content goes, so nothing is
    # revealed and the move proceeds, the hidden file riding along.
    ws = _boxed({"paths": {"hide": ["*.tkn"]}})
    ok = _run(ws, "mv /repo/box /repo/moved")
    assert ok.exit_code == 0, ok.stderr
    listing = _run(ws, "ls /repo/moved")
    assert (listing.stdout or b"") == b"a.txt\nsec\n"
    survived = _host(ws, "cat /repo/moved/x.tkn")
    assert survived.exit_code == 0 and (survived.stdout or b"") == b"t\n"


def test_mv_of_a_file_under_an_anchored_pattern_hide_passes():
    # /repo/*/sec could match below any directory under /repo, so a
    # directory move refuses conservatively, but a regular file carries
    # nothing below it: renaming one reveals nothing.
    ws = _boxed({"paths": {"hide": ["/repo/*/sec"]}})
    moved = _run(ws, "mv /repo/box/a.txt /repo/box/b.txt")
    assert moved.exit_code == 0, moved.stderr
    listing = _run(ws, "ls /repo/box")
    assert b"b.txt" in (listing.stdout or b"")


def test_mv_of_a_directory_under_an_anchored_pattern_hide_refuses():
    ws = _boxed({"paths": {"hide": ["/repo/*/sec"]}})
    refused = _run(ws, "mv /repo/box /repo/moved")
    assert refused.exit_code == 1
    assert b"Permission denied" in (refused.stderr or b"")


def test_mv_b_refusal_leaves_the_destination_backup_free():
    # The reveal guard answers before -b renames the destination aside,
    # so a refused move mutates nothing: no backup, destination intact.
    ws = _boxed({"paths": {"hide": ["/repo/box/sec"]}})
    prep = _run(ws, "mkdir /repo/moved")
    assert prep.exit_code == 0, prep.stderr
    refused = _run(ws, "mv -b -T /repo/box /repo/moved")
    assert refused.exit_code == 1
    assert b"Permission denied" in (refused.stderr or b"")
    intact = _host(ws, "test -d /repo/moved")
    assert intact.exit_code == 0
    backup = _host(ws, "test -e /repo/moved~")
    assert backup.exit_code == 1


def test_cp_r_copies_the_visible_view_silently():
    ws = _boxed({"paths": {"hide": ["/repo/box/sec"]}})
    copied = _run(ws, "cp -r /repo/box /repo/copy")
    assert copied.exit_code == 0, copied.stderr
    assert (copied.stderr or b"") == b""
    listing = _host(ws, "find /repo/copy")
    assert (listing.stdout
            or b"") == (b"/repo/copy\n/repo/copy/a.txt\n/repo/copy/x.tkn\n")


def test_rmdir_takes_hidden_remnants_with_the_directory():
    # The session sees an empty directory; a not-empty refusal would
    # leak that something invisible exists, so the remnants go with it.
    ws = _boxed({"paths": {"hide": ["/repo/only/h"]}})
    empty = _run(ws, "ls -a /repo/only")
    assert (empty.stdout or b"") == b""
    removed = _run(ws, "rmdir /repo/only")
    assert removed.exit_code == 0, removed.stderr
    gone = _host(ws, "test -e /repo/only")
    assert gone.exit_code == 1


def test_rmdir_with_a_visible_child_keeps_the_refusal():
    ws = _boxed({"paths": {"hide": ["/repo/box/sec"]}})
    refused = _run(ws, "rmdir /repo/box")
    assert refused.exit_code == 1
    assert b"Directory not empty" in (refused.stderr or b"")


def test_rm_r_still_destroys_hidden_content_below():
    ws = _boxed({"paths": {"hide": ["/repo/box/sec"]}})
    removed = _run(ws, "rm -r /repo/box")
    assert removed.exit_code == 0, removed.stderr
    gone = _host(ws, "test -e /repo/box")
    assert gone.exit_code == 1


def test_a_read_only_hidden_remnant_keeps_the_refusal():
    # A show may state a mode at the same anchor a hide covers (the
    # hide wins visibility on the tie), leaving content the session
    # cannot see that its mode still protects. Every cascade deletion
    # answers for its own path's mode, so the protected remnant
    # survives and the rmdir keeps a not-empty refusal.
    ws = _boxed(
        {"paths": {
            "hide": ["/repo/only/h"],
            "show": {
                "/repo/only/h": "r"
            }
        }})
    refused = _run(ws, "rmdir /repo/only")
    assert refused.exit_code == 1
    assert (refused.stderr or b"") == (
        b"rmdir: failed to remove '/repo/only': Directory not empty\n")
    kept = _host(ws, "cat /repo/only/h")
    assert (kept.stdout or b"") == b"h\n"


def test_a_mounted_child_keeps_the_command_planes_refusal():
    # Command-plane twin of the ops door's merged emptiness: the
    # backend listing holds only hidden entries, but the namespace owes
    # the directory a visible mounted child no backend can list. The
    # stamped children join the guard's emptiness judgment, so the
    # not-empty refusal stays instead of the cascade destroying the
    # hidden remnant and reporting success while the mount remains.
    ws = Workspace({
        "/repo": RAMResource(),
        "/repo/only/m": RAMResource()
    },
                   mode=MountMode.WRITE)

    async def seed():
        io = await ws.execute(
            "mkdir -p /repo/only && printf 'h\\n' > /repo/only/h")
        assert io.exit_code == 0, io.stderr

    asyncio.run(seed())
    ws.create_session("rev", profile={"paths": {"hide": ["/repo/only/h"]}})
    refused = _run(ws, "rmdir /repo/only")
    assert refused.exit_code == 1
    assert (refused.stderr or b"") == (
        b"rmdir: failed to remove '/repo/only': Directory not empty\n")
    kept = _host(ws, "cat /repo/only/h")
    assert (kept.stdout or b"") == b"h\n"


def test_ops_rmdir_keeps_the_refusal_when_a_mounted_child_remains():
    # Ops-plane twin of the visible-child rule: the backend cannot see
    # a mount nested below the directory, so the remnant arm judges
    # emptiness on the door's merged listing. The visible mounted child
    # keeps the not-empty refusal instead of the arm destroying the
    # hidden backend remnants and reporting a successful rmdir while
    # the mount remains.
    ws = Workspace({
        "/a": RAMResource(),
        "/a/d/m": RAMResource()
    },
                   mode=MountMode.WRITE)

    async def seed():
        io = await ws.execute("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k"
                              )
        assert io.exit_code == 0, io.stderr

    asyncio.run(seed())
    sess = ws.create_session("rev", profile={"paths": {"hide": ["/a/d/sec"]}})

    async def probe():
        try:
            await ws.fs.rmdir("/a/d")
        except OSError as exc:
            return exc
        return None

    token = set_current_session(sess)
    try:
        refused = asyncio.run(probe())
    finally:
        reset_current_session(token)
    assert refused is not None
    assert refused.errno in (errno.ENOTEMPTY, errno.EEXIST)
    kept = _host(ws, "cat /a/d/sec/k")
    assert (kept.stdout or b"") == b"k\n"
