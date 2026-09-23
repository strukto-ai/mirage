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

from types import SimpleNamespace

import pytest

from mirage.observe.record import (CONTENT_CHANGING_OPS,
                                   RETRACT_FINGERPRINT_OPS,
                                   STAMP_FINGERPRINT_OPS, SUBTREE_RETRACT_OPS,
                                   OpRecord)
from mirage.workspace.snapshot.drift import capture_fingerprints
from mirage.workspace.snapshot.keys import FingerprintKey


def _rec(op: str,
         path: str,
         fingerprint: str | None = None,
         revision: str | None = None,
         timestamp: int = 0) -> OpRecord:
    return OpRecord(op=op,
                    path=path,
                    source="s3",
                    bytes=0,
                    timestamp=timestamp,
                    duration_ms=0,
                    fingerprint=fingerprint,
                    revision=revision)


def _mount(prefix: str, supports_snapshot: bool = True):
    return SimpleNamespace(
        prefix=prefix,
        mount_id=None,
        vfs=SimpleNamespace(SUPPORTS_SNAPSHOT=supports_snapshot))


def _longest_prefix(mounts: list, path: str):
    """Resolve a path to its mount the way the real registry does.

    Longest prefix wins, and a mount root resolves to itself however it
    is spelled. A stub matching only ``startswith("/s3/")`` answered
    None for the bare "/s3", which sent a mount-root retraction down the
    unbounded sweep and made that case pass for the wrong reason.

    Args:
        mounts (list): the mount table, in any order.
        path (str): the virtual path to resolve.
    """
    base = path.rstrip("/") + "/"
    best = None
    for mount in mounts:
        if base.startswith(mount.prefix) and (best is None or len(mount.prefix)
                                              > len(best.prefix)):
            best = mount
    return best


def _ws(records: list[OpRecord],
        supports_snapshot: bool = True,
        mounts: list | None = None):
    """A workspace stub exposing only what capture_fingerprints reads.

    Args:
        records (list[OpRecord]): the session's op log.
        supports_snapshot (bool): the default mount's replay capability.
        mounts (list | None): the mount table; one "/s3/" mount when
            omitted.
    """
    table = mounts if mounts is not None else [
        _mount("/s3/", supports_snapshot)
    ]
    return SimpleNamespace(
        _ops=SimpleNamespace(records=records),
        _registry=SimpleNamespace(
            try_mount_for=lambda path: _longest_prefix(table, path)),
    )


def _paths(entries) -> list[str]:
    return [e[FingerprintKey.PATH] for e in entries]


def test_emits_one_entry_per_fingerprinted_path():
    entries = capture_fingerprints(
        _ws([
            _rec("read", "/s3/a", "fp-a"),
            _rec("read", "/s3/b", "fp-b", "rev-b")
        ]))
    assert entries == [
        {
            FingerprintKey.PATH: "/s3/a",
            FingerprintKey.MOUNT_PREFIX: "/s3/",
            FingerprintKey.FINGERPRINT: "fp-a",
        },
        {
            FingerprintKey.PATH: "/s3/b",
            FingerprintKey.MOUNT_PREFIX: "/s3/",
            FingerprintKey.FINGERPRINT: "fp-b",
            FingerprintKey.REVISION: "rev-b",
        },
    ]


def test_deduplicates_by_path_last_record_wins():
    """sed -i reads then writes one path; snapshotting the pre-edit token
    would raise ContentDriftError on a file only mirage touched."""
    entries = capture_fingerprints(
        _ws([
            _rec("read", "/s3/a", "fp-old"),
            _rec("write", "/s3/a", "fp-new")
        ]))
    assert [e[FingerprintKey.FINGERPRINT] for e in entries] == ["fp-new"]


def test_captures_a_write_that_carries_a_token():
    entries = capture_fingerprints(_ws([_rec("write", "/s3/a", "fp-a")]))
    assert _paths(entries) == ["/s3/a"]


def test_skips_an_op_that_stamps_no_token_at_all():
    entries = capture_fingerprints(_ws([_rec("readdir", "/s3/a", "fp-a")]))
    assert entries == []


def test_skips_a_read_with_neither_marker():
    assert capture_fingerprints(_ws([_rec("read", "/s3/a")])) == []


def test_retracts_a_pin_when_the_object_is_removed():
    entries = capture_fingerprints(
        _ws([_rec("write", "/s3/a", "fp-a"),
             _rec("unlink", "/s3/a")]))
    assert entries == []


def test_a_retraction_takes_the_whole_subtree_with_it():
    entries = capture_fingerprints(
        _ws([
            _rec("write", "/s3/d/f", "fp-f"),
            _rec("write", "/s3/ab.txt", "fp-ab"),
            _rec("rm_r", "/s3/d"),
        ]))
    assert _paths(entries) == ["/s3/ab.txt"]


def test_a_sibling_sharing_a_name_prefix_is_not_retracted():
    entries = capture_fingerprints(
        _ws([_rec("write", "/s3/ab.txt", "fp-ab"),
             _rec("unlink", "/s3/a")]))
    assert _paths(entries) == ["/s3/ab.txt"]


@pytest.mark.parametrize("root", ["/s3", "/s3/"])
def test_a_mount_root_retraction_drops_the_mount_either_spelling(root):
    """python records a mount root as "/s3/" and TypeScript as "/s3"; the
    probe is normalized so the two languages cannot disagree."""
    entries = capture_fingerprints(
        _ws([_rec("write", "/s3/a", "fp-a"),
             _rec("rm_r", root)]))
    assert entries == []


def test_a_rewrite_after_a_retraction_pins_the_new_token():
    entries = capture_fingerprints(
        _ws([
            _rec("write", "/s3/a", "fp-1"),
            _rec("unlink", "/s3/a"),
            _rec("write", "/s3/a", "fp-2"),
        ]))
    assert [e[FingerprintKey.FINGERPRINT] for e in entries] == ["fp-2"]


def test_a_tokenless_write_retracts_the_pin_it_cannot_describe():
    """gdrive's shape: it stamps a read fingerprint but records a
    tokenless write, so the pre-write token must not survive."""
    entries = capture_fingerprints(
        _ws([_rec("read", "/s3/a", "fp-read"),
             _rec("write", "/s3/a")]))
    assert entries == []


def test_an_append_retracts_since_it_never_carries_a_token():
    entries = capture_fingerprints(
        _ws([_rec("read", "/s3/a", "fp-read"),
             _rec("append", "/s3/a")]))
    assert entries == []


def test_a_read_reporting_no_token_leaves_the_pin_alone():
    entries = capture_fingerprints(
        _ws([_rec("write", "/s3/a", "fp-a"),
             _rec("read", "/s3/a")]))
    assert [e[FingerprintKey.FINGERPRINT] for e in entries] == ["fp-a"]


def test_replaces_the_entry_whole_so_a_read_revision_cannot_outlive_it():
    """install_fingerprints pins on a revision and skips the drift check,
    so a read's revision surviving onto a later write would pin replay to
    the bytes that preceded the write."""
    entries = capture_fingerprints(
        _ws([
            _rec("read", "/s3/a", "fp-read", "rev-read"),
            _rec("write", "/s3/a", "fp-write"),
        ]))
    assert entries == [{
        FingerprintKey.PATH: "/s3/a",
        FingerprintKey.MOUNT_PREFIX: "/s3/",
        FingerprintKey.FINGERPRINT: "fp-write",
    }]


def test_skips_mounts_that_opt_out_of_snapshot_replay():
    entries = capture_fingerprints(
        _ws([_rec("read", "/s3/a", "fp-a")], supports_snapshot=False))
    assert entries == []


# ── the destination of a move or a copy, which src alone never covers ─────


def test_a_move_retracts_the_destination_pin_too():
    """`mv a b` replaces b's bytes with a's, so b's own token stops
    describing its object. The src record alone would leave it pinned."""
    entries = capture_fingerprints(
        _ws([
            _rec("write", "/s3/a", "fp-a"),
            _rec("write", "/s3/b", "fp-b"),
            _rec("rename", "/s3/a"),
            _rec("rename", "/s3/b"),
        ]))
    assert entries == []


def test_a_copy_retracts_the_destination_pin():
    """A copy leaves src valid and replaces dst, so only dst is dropped."""
    entries = capture_fingerprints(
        _ws([
            _rec("write", "/s3/a", "fp-a"),
            _rec("write", "/s3/b", "fp-b"),
            _rec("copy", "/s3/b"),
        ]))
    assert _paths(entries) == ["/s3/a"]


# ── set membership, which the behaviour tests alone do not pin ────────────


def test_the_four_op_sets_hold_exactly_what_the_ladder_needs():
    """Each member is load-bearing: dropping one silently changes which
    arm an op takes, and every behaviour test would still pass."""
    assert STAMP_FINGERPRINT_OPS == {"read", "write", "create", "truncate"}
    assert CONTENT_CHANGING_OPS == {"write", "create", "truncate", "append"}
    assert RETRACT_FINGERPRINT_OPS == {
        "unlink", "rm_r", "rmdir", "rename", "rename_prefix", "copy"
    }
    assert SUBTREE_RETRACT_OPS == {"rm_r", "rename_prefix"}


@pytest.mark.parametrize("op", sorted(RETRACT_FINGERPRINT_OPS))
def test_every_retracting_op_drops_a_pin(op):
    entries = capture_fingerprints(
        _ws([_rec("write", "/s3/a", "fp-a"),
             _rec(op, "/s3/a")]))
    assert entries == []


@pytest.mark.parametrize("op", sorted(STAMP_FINGERPRINT_OPS))
def test_every_stamping_op_can_set_a_pin(op):
    entries = capture_fingerprints(_ws([_rec(op, "/s3/a", "fp-a")]))
    assert _paths(entries) == ["/s3/a"]


@pytest.mark.parametrize("op", sorted(CONTENT_CHANGING_OPS))
def test_every_content_changing_op_drops_a_pin_it_cannot_describe(op):
    entries = capture_fingerprints(
        _ws([_rec("read", "/s3/a", "fp-read"),
             _rec(op, "/s3/a")]))
    assert entries == []


@pytest.mark.parametrize("op", sorted(SUBTREE_RETRACT_OPS))
def test_every_subtree_retracting_op_takes_a_descendant_pin(op):
    entries = capture_fingerprints(
        _ws([_rec("write", "/s3/a/b", "fp-b"),
             _rec(op, "/s3/a")]))
    assert entries == []


@pytest.mark.parametrize("op",
                         sorted(RETRACT_FINGERPRINT_OPS - SUBTREE_RETRACT_OPS))
def test_every_point_retracting_op_leaves_a_descendant_pin(op):
    """On a keyed store "a" and "a/b" are both objects, and `rm a` leaves
    "a/b" alone; only an op that can move a whole prefix takes one."""
    entries = capture_fingerprints(
        _ws([_rec("write", "/s3/a/b", "fp-b"),
             _rec(op, "/s3/a")]))
    assert _paths(entries) == ["/s3/a/b"]


def test_a_mount_root_retraction_leaves_a_nested_mount_alone():
    """A nested mount's keys live in a different backend, so an op on the
    parent never touched them. Worst at "/", where every virtual path
    reads as being under the retracted root."""
    entries = capture_fingerprints(
        _ws([
            _rec("write", "/x", "fp-x"),
            _rec("write", "/s3/a", "fp-a"),
            _rec("rm_r", "/"),
        ],
            mounts=[_mount("/"), _mount("/s3/")]))
    assert _paths(entries) == ["/s3/a"]


def test_records_are_ordered_by_timestamp_not_by_position():
    """A backend record reaches the list when its line ends, while an
    `Ops` facade record appends as it happens, so a retraction can sit
    ahead of the write it precedes in time."""
    entries = capture_fingerprints(
        _ws([
            _rec("write", "/s3/a", "fp-a", timestamp=2),
            _rec("unlink", "/s3/a", timestamp=1),
        ]))
    assert _paths(entries) == ["/s3/a"]


def test_same_millisecond_records_keep_their_order():
    """The sort is stable, so an unlink and the rewrite that followed it
    inside one millisecond do not swap."""
    entries = capture_fingerprints(
        _ws([_rec("unlink", "/s3/a"),
             _rec("write", "/s3/a", "fp-new")]))
    assert _paths(entries) == ["/s3/a"]


def test_a_content_changing_op_carrying_an_unusable_token_still_drops():
    """`append` is in CONTENT_CHANGING but not in STAMP, so it never
    reaches the stamping arm; a token on its record must not buy the
    pre-append pin a reprieve it cannot use."""
    entries = capture_fingerprints(
        _ws([
            _rec("read", "/s3/a", "fp-read"),
            _rec("append", "/s3/a", "fp-append")
        ]))
    assert entries == []


def test_an_empty_fingerprint_beside_a_revision_still_pins():
    """The token test is truthiness, not None-ness: an empty string is
    no token, but the revision beside it is one."""
    entries = capture_fingerprints(_ws([_rec("write", "/s3/a", "", "rev-1")]))
    assert _paths(entries) == ["/s3/a"]
