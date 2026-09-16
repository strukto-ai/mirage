from __future__ import annotations

import argparse
import collections
import subprocess
import sys
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def tracked_paths() -> list[str]:
    """Every path git has, which is what a checkout has to write.

    Returns:
        list[str]: repository-relative paths, in git's own order.
    """
    out = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "-z"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [p for p in out.split("\0") if p]


def fold(path: str) -> str:
    """The one name a case- and form-insensitive filesystem stores.

    APFS and NTFS fold case, and APFS also normalizes Unicode, so two
    paths that differ only in either are one file on disk. `casefold`
    rather than `lower`, since it folds the pairs `lower` leaves alone.

    Args:
        path: A repository-relative path.

    Returns:
        str: the folded name two colliding paths share.
    """
    return unicodedata.normalize("NFC", path).casefold()


def collisions(paths: list[str]) -> dict[str, list[str]]:
    """Group the paths that a macOS or Windows checkout cannot separate.

    Args:
        paths: Every tracked path.

    Returns:
        dict[str, list[str]]: folded name to the paths sharing it, for
            the groups holding more than one.
    """
    grouped: dict[str, list[str]] = collections.defaultdict(list)
    for path in paths:
        grouped[fold(path)].append(path)
    return {
        name: sorted(group)
        for name, group in grouped.items() if len(group) > 1
    }


def selftest() -> int:
    """Prove the fold catches both traps before trusting it on the tree.

    The case pair is the one that has already landed (`B.json` beside a
    new `b.json`); the Unicode pair is the one APFS adds, where a
    precomposed name and its decomposed spelling are the same file.

    Returns:
        int: 0 when every case is caught, 1 otherwise.
    """
    cases: list[tuple[list[str], int]] = [
        (["integ/unix/grep/B.json", "integ/unix/grep/b.json"], 1),
        (["a/café.txt", "a/café.txt"], 1),
        (["a/one.json", "a/two.json"], 0),
        (["a/B.upper.json", "a/b.json"], 0),
    ]
    failures = 0
    for paths, want in cases:
        got = len(collisions(paths))
        if got != want:
            failures += 1
            print(f"  selftest: {paths} -> {got} group(s), wanted {want}")
    if failures:
        print(f"\nFAIL: {failures} selftest case(s); the gate is blind to a "
              "collision it claims to catch.")
        return 1
    print(f"selftest OK: {len(cases)} cases covered")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Refuse two tracked paths that are one file on a "
        "case-insensitive or Unicode-normalizing filesystem.")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    found = collisions(tracked_paths())
    for _, group in sorted(found.items()):
        print(f"  collide: {' | '.join(group)}")
    if found:
        print(f"\nFAIL: {len(found)} path group(s) differ only by case or "
              "Unicode form. On macOS and Windows they are one file: a "
              "checkout writes whichever comes last, the tree reads as "
              "dirty, and one file's content stands in for the other's. "
              "Rename one -- the goldens use a `.upper.json` suffix for an "
              "uppercase flag.")
        return 1
    print("path collisions: none; every tracked path is its own file "
          "on a case-insensitive filesystem")
    return 0


if __name__ == "__main__":
    sys.exit(main())
