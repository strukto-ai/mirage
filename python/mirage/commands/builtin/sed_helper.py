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

import re
from functools import partial

from mirage.commands.builtin.utils.types import _ReadBytes, _WriteBytes

_SIMPLE_CMDS = frozenset("dDpPhHgGxNq")


def _apply_repl(m: "re.Match[str]", repl: str) -> str:
    """Expand a GNU sed replacement against a match.

    `&` is the whole match, `\\1`..`\\9` are groups, `\\&` is a literal `&`,
    `\\n`/`\\t` are newline/tab, and `\\X` is a literal X.

    Args:
        m (re.Match): The regex match for the current substitution.
        repl (str): The sed replacement template.
    """
    out: list[str] = []
    i = 0
    while i < len(repl):
        ch = repl[i]
        if ch == "\\" and i + 1 < len(repl):
            nxt = repl[i + 1]
            if nxt.isdigit():
                grp = m.group(int(nxt))
                out.append(grp if grp is not None else "")
            elif nxt == "n":
                out.append("\n")
            elif nxt == "t":
                out.append("\t")
            else:
                out.append(nxt)
            i += 2
        elif ch == "&":
            out.append(m.group(0))
            i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _parse_address(addr: str) -> tuple[str, str] | None:
    if not addr:
        return None
    if addr[0] == "/":
        end = addr.index("/", 1)
        return ("regex", addr[1:end])
    if addr.isdigit():
        return ("line", addr)
    if addr == "$":
        return ("last", "")
    return None


def _consume_address(rest: str) -> tuple[tuple[str, str] | None, str]:
    if not rest:
        return None, rest
    if rest[0] == "/":
        end = rest.index("/", 1)
        addr = ("regex", rest[1:end])
        return addr, rest[end + 1:]
    if rest[0].isdigit() or rest[0] == "$":
        num = ""
        while rest and (rest[0].isdigit() or rest[0] == "$"):
            num += rest[0]
            rest = rest[1:]
        return _parse_address(num), rest
    return None, rest


def _parse_one_command(rest: str) -> tuple[dict, str]:
    addr_start = None
    addr_end = None

    addr_start, rest = _consume_address(rest)
    if addr_start and rest.startswith(","):
        addr_end, rest = _consume_address(rest[1:])

    if not rest:
        raise ValueError("sed: missing command")

    ch = rest[0]

    if ch == "{":
        return {
            "cmd": "{",
            "addr_start": addr_start,
            "addr_end": addr_end,
        }, rest[1:]
    if ch == "}":
        return {"cmd": "}"}, rest[1:]
    if ch == ":":
        label = ""
        rest = rest[1:]
        while rest and rest[0] not in (";", "}"):
            label += rest[0]
            rest = rest[1:]
        return {
            "cmd": ":",
            "label": label.strip(),
        }, rest
    if ch == "b":
        label = ""
        rest = rest[1:]
        while rest and rest[0] not in (";", "}"):
            label += rest[0]
            rest = rest[1:]
        return {
            "cmd": "b",
            "label": label.strip(),
            "addr_start": addr_start,
            "addr_end": addr_end,
        }, rest
    if ch == "t":
        label = ""
        rest = rest[1:]
        while rest and rest[0] not in (";", "}"):
            label += rest[0]
            rest = rest[1:]
        return {
            "cmd": "t",
            "label": label.strip(),
            "addr_start": addr_start,
            "addr_end": addr_end,
        }, rest
    if ch == "s":
        delim = rest[1]
        parts = rest[2:].split(delim)
        pattern = parts[0]
        replacement = parts[1] if len(parts) > 1 else ""
        expr_flags = parts[2] if len(parts) > 2 else ""
        remaining = delim.join(parts[3:]) if len(parts) > 3 else ""
        return {
            "cmd": "s",
            "pattern": pattern,
            "replacement": replacement,
            "expr_flags": expr_flags,
            "addr_start": addr_start,
            "addr_end": addr_end,
        }, remaining
    if ch in _SIMPLE_CMDS:
        return {
            "cmd": ch,
            "addr_start": addr_start,
            "addr_end": addr_end,
        }, rest[1:]
    if ch in ("a", "i"):
        text = rest[1:]
        if text and text[0] in ("\\", " "):
            text = text[1:]
        end = len(text)
        for j, c in enumerate(text):
            if c == ";":
                end = j
                break
        return {
            "cmd": ch,
            "text": text[:end],
            "addr_start": addr_start,
            "addr_end": addr_end,
        }, text[end:]

    raise ValueError(f"sed: unsupported command: {ch!r}")


def _parse_program(expr: str) -> list[dict]:
    commands: list[dict] = []
    rest = expr.strip()
    while rest:
        if rest[0] in (";", "\n"):
            rest = rest[1:].lstrip()
            continue
        if rest[0] == " ":
            rest = rest[1:]
            continue
        cmd, rest = _parse_one_command(rest)
        commands.append(cmd)
        rest = rest.lstrip()
    return commands


def _addr_matches(addr: tuple[str, str], line: str, lineno: int,
                  total: int) -> bool:
    kind, val = addr
    if kind == "line":
        return lineno == int(val)
    if kind == "last":
        return lineno == total
    if kind == "regex":
        return re.search(val, line) is not None
    return False


def _execute_program(text: str,
                     commands: list[dict],
                     suppress: bool = False) -> str:
    lines = text.splitlines(keepends=True)
    total = len(lines)
    hold = ""
    output: list[str] = []
    label_map: dict[str, int] = {}
    for idx, cmd in enumerate(commands):
        if cmd["cmd"] == ":":
            label_map[cmd["label"]] = idx
    range_active: dict[int, bool] = {}

    i = 0
    while i < total:
        pattern = lines[i]
        i += 1
        lineno = i
        deferred: list[str] = []

        pc = 0
        delete = False
        substituted = False

        while pc < len(commands):
            cmd = commands[pc]
            c = cmd["cmd"]

            if c == ":" or c == "}":
                pc += 1
                continue

            addr_start = cmd.get("addr_start")
            addr_end = cmd.get("addr_end")

            matched = True
            if addr_start is not None:
                if addr_end is not None:
                    rid = id(cmd)
                    if not range_active.get(rid, False):
                        if _addr_matches(addr_start, pattern, lineno, total):
                            range_active[rid] = True
                        else:
                            matched = False
                    if range_active.get(rid, False):
                        if _addr_matches(addr_end, pattern, lineno, total):
                            range_active[rid] = False
                else:
                    if not _addr_matches(addr_start, pattern, lineno, total):
                        matched = False

            if c == "{":
                if not matched:
                    depth = 1
                    pc += 1
                    while pc < len(commands) and depth > 0:
                        if commands[pc]["cmd"] == "{":
                            depth += 1
                        elif commands[pc]["cmd"] == "}":
                            depth -= 1
                        pc += 1
                    continue
                pc += 1
                continue

            if not matched:
                pc += 1
                continue

            if c == "s":
                pat = cmd["pattern"]
                repl = cmd["replacement"]
                eflags = cmd["expr_flags"]
                re_flags = re.IGNORECASE if "i" in eflags else 0
                count = 0 if "g" in eflags else 1
                new_pattern = re.sub(pat,
                                     partial(_apply_repl, repl=repl),
                                     pattern,
                                     flags=re_flags,
                                     count=count)
                if new_pattern != pattern:
                    substituted = True
                pattern = new_pattern
            elif c == "d":
                delete = True
                break
            elif c == "D":
                nl = pattern.find("\n")
                if nl >= 0:
                    pattern = pattern[nl + 1:]
                    pc = 0
                    continue
                delete = True
                break
            elif c == "p":
                output.append(pattern)
            elif c == "P":
                nl = pattern.find("\n")
                output.append(pattern[:nl + 1] if nl >= 0 else pattern)
            elif c == "N":
                if i < total:
                    pattern += lines[i]
                    i += 1
                else:
                    break
            elif c == "h":
                hold = pattern
            elif c == "H":
                hold = hold + "\n" + pattern if hold else pattern
            elif c == "g":
                pattern = hold
            elif c == "G":
                pattern = pattern + "\n" + hold if hold else pattern
            elif c == "x":
                pattern, hold = hold, pattern
            elif c == "a":
                deferred.append(cmd["text"] + "\n")
            elif c == "i":
                output.append(cmd["text"] + "\n")
            elif c == "q":
                output.append(pattern)
                return "".join(output)
            elif c == "b":
                label = cmd.get("label", "")
                if label and label in label_map:
                    pc = label_map[label]
                    continue
                break
            elif c == "t":
                if substituted:
                    substituted = False
                    label = cmd.get("label", "")
                    if label and label in label_map:
                        pc = label_map[label]
                        continue
                    break

            pc += 1

        if not delete:
            if not suppress:
                output.append(pattern)
            output.extend(deferred)

    return "".join(output)


def sed(
    read_bytes: _ReadBytes,
    write_bytes: _WriteBytes,
    path: str,
    pattern: str,
    replacement: str,
    flags: int = 0,
    count: int = 0,
) -> None:
    data = read_bytes(path).decode(errors="replace")
    new_data = re.sub(pattern,
                      partial(_apply_repl, repl=replacement),
                      data,
                      flags=flags,
                      count=count)
    write_bytes(path, new_data.encode())
