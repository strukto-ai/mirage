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

import argparse
import json
import re
import shlex
from collections import defaultdict
from pathlib import Path

INTEG = Path(__file__).resolve().parents[2]
CATEGORIES = ("unix", "bash", "crossmount", "resources")
SEGMENT_RE = re.compile(r"\|\||&&|;|\||\(|\)")
ASSIGN_RE = re.compile(r"^\w+=")
SHORTFLAG_RE = re.compile(r"^([A-Za-z]+)(\d.*)?$")
SANITIZE_RE = re.compile(r"[^A-Za-z0-9]+")
ERROR_ID_RE = re.compile(r"unknown|usage|missing|invalid|badflag|noarg")
SINGLE_DASH_LONG = {"find"}
COLLAPSE_THRESHOLD = 15


def sanitize(token: str) -> str:
    cleaned = SANITIZE_RE.sub("_", token).strip("_")
    return cleaned or "misc"


def resolve_stems(facets: list[str]) -> dict[str, str]:
    groups: dict[str, list[str]] = defaultdict(list)
    for facet in facets:
        groups[facet.casefold()].append(facet)
    stems: dict[str, str] = {}
    for members in groups.values():
        if len(members) == 1:
            stems[members[0]] = members[0]
            continue
        for facet in members:
            stems[facet] = facet if facet == facet.lower(
            ) else f"{facet}.upper"
    return stems


def tokenize(segment: str) -> list[str]:
    try:
        return shlex.split(segment)
    except ValueError:
        return segment.split()


def command_flags(command: str, name: str) -> list[str] | None:
    for segment in SEGMENT_RE.split(command):
        toks = tokenize(segment.strip())
        i = 0
        while i < len(toks) and ASSIGN_RE.match(toks[i]):
            i += 1
        if i >= len(toks) or toks[i] != name:
            continue
        return parse_flag_tokens(toks[i + 1:], name)
    return None


def parse_flag_tokens(args: list[str], name: str) -> list[str]:
    flags: list[str] = []
    for tok in args:
        if tok == "--":
            break
        if tok == "-" or not tok.startswith("-"):
            continue
        if tok.startswith("--"):
            long = tok[2:].split("=", 1)[0]
            if long:
                flags.append(long)
            continue
        body = tok[1:]
        if name in SINGLE_DASH_LONG:
            flags.append(body)
            continue
        match = SHORTFLAG_RE.match(body)
        if match:
            flags.extend(match.group(1))
        else:
            flags.append(body)
    seen: set[str] = set()
    ordered: list[str] = []
    for flag in flags:
        if flag not in seen:
            seen.add(flag)
            ordered.append(flag)
    return ordered


def is_command_file(name: str, cases: list[dict]) -> bool:
    hits = sum(1 for c in cases
               if command_flags(c["command"], name) is not None)
    return hits * 2 >= len(cases)


def common_prefix_len(cases: list[dict]) -> int:
    split_ids = [c["id"].split("_") for c in cases]
    length = 0
    for column in zip(*split_ids):
        if len(set(column)) == 1:
            length += 1
        else:
            break
    return length


def command_facet(case: dict, name: str) -> tuple[str, list[str]]:
    flags = command_flags(case["command"], name) or []
    expect = case["expect"]
    is_error = expect["exit"] != 0 and expect.get("stderr", "").strip()
    if is_error or ERROR_ID_RE.search(case["id"]):
        return "error", flags
    if not flags:
        if "operand" in case["id"]:
            return "operand", flags
        return "basic", flags
    return sanitize(flags[0]), flags


def feature_facet(case: dict, prefix_len: int) -> str:
    rest = case["id"].split("_")[prefix_len:]
    return sanitize(rest[0]) if rest else "basic"


def plan_file(path: Path) -> tuple[str, list[tuple[str, dict, list[str]]]]:
    data = json.loads(path.read_text())
    cases = data["cases"]
    name = path.stem
    category = path.parent.name
    rows: list[tuple[str, dict, list[str]]] = []
    if category == "unix" and is_command_file(name, cases):
        strategy = "flags"
        for case in cases:
            facet, flags = command_facet(case, name)
            rows.append((facet, case, flags))
    else:
        strategy = "id"
        prefix_len = common_prefix_len(cases)
        tentative = [(feature_facet(case, prefix_len), case) for case in cases]
        if len({facet for facet, _ in tentative}) > COLLAPSE_THRESHOLD:
            strategy = "id-collapsed"
            rows = [("basic", case, []) for _, case in tentative]
        else:
            rows = [(facet, case, []) for facet, case in tentative]
    return strategy, rows


def write_tree(path: Path, rows: list[tuple[str, dict, list[str]]],
               populate_flags: bool) -> dict[str, int]:
    name = path.stem
    dest_dir = path.parent / name
    buckets: dict[str, list[dict]] = defaultdict(list)
    for facet, case, flags in rows:
        if populate_flags and flags:
            case["flags"] = flags
        buckets[facet].append(case)
    stems = resolve_stems(list(buckets))
    dest_dir.mkdir(parents=True, exist_ok=True)
    for facet, cases in buckets.items():
        out = dest_dir / f"{stems[facet]}.json"
        out.write_text(
            json.dumps({"cases": cases}, indent=2, ensure_ascii=False) + "\n")
    path.unlink()
    return {facet: len(cases) for facet, cases in buckets.items()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--only", default="")
    parser.add_argument("--no-flags", action="store_true")
    args = parser.parse_args()
    only = {s for s in args.only.split(",") if s}

    files: list[Path] = []
    for category in CATEGORIES:
        files.extend(sorted((INTEG / category).glob("*.json")))

    total_cases = 0
    total_files = 0
    for path in files:
        rel = f"{path.parent.name}/{path.stem}"
        if only and rel not in only and path.parent.name not in only:
            continue
        strategy, rows = plan_file(path)
        buckets: dict[str, int] = defaultdict(int)
        for facet, _case, _flags in rows:
            buckets[facet] += 1
        stems = resolve_stems(list(buckets))
        lowered = {stem.casefold() for stem in stems.values()}
        if len(lowered) != len(stems):
            raise SystemExit(f"case-insensitive stem collision in {rel}")
        total_cases += len(rows)
        total_files += len(buckets)
        print(f"{rel}.json  [{strategy}]  {len(rows)} cases -> "
              f"{len(buckets)} facets")
        for facet in sorted(buckets):
            print(f"    {stems[facet]:16} {buckets[facet]}")
        if args.apply:
            write_tree(path, rows, not args.no_flags)
    print(f"\n{'APPLIED' if args.apply else 'DRY-RUN'}: "
          f"{total_cases} cases -> {total_files} facet files")


if __name__ == "__main__":
    main()
