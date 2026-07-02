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

import time
from collections.abc import Callable
from datetime import datetime, timezone

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.utils.path import CycleError
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.types import ExecutionNode

_Result = tuple[ByteSource | None, IOResult, ExecutionNode]

_MODE_CLASS_BITS = {"u": 0o700, "g": 0o070, "o": 0o007, "a": 0o777}
_MODE_PERM_BITS = {"r": 0o444, "w": 0o222, "x": 0o111}


def _error(cmd: str, message: str, exit_code: int = 1) -> _Result:
    err = message.encode()
    return None, IOResult(exit_code=exit_code,
                          stderr=err), ExecutionNode(command=cmd,
                                                     exit_code=exit_code,
                                                     stderr=err)


def _ok(cmd: str) -> _Result:
    return None, IOResult(), ExecutionNode(command=cmd, exit_code=0)


def parse_mode(text: str, current: int) -> int | None:
    """Parse a chmod MODE argument (octal or symbolic).

    Symbolic supports the common grammar: ``[ugoa...][+-=][rwx...]``
    clauses joined by commas (``u+x``, ``go-w``, ``a=r``, ``+x``).
    Special bits (s, t, X) are not supported.

    Args:
        text (str): the MODE operand as typed.
        current (int): current permission bits the clauses apply to.

    Returns:
        int | None: the new mode, or None when the text does not parse.

    Example::

        parse_mode("644", 0)          -> 0o644
        parse_mode("u+x", 0o644)      -> 0o744
        parse_mode("a=r", 0o777)      -> 0o444
    """
    if text and all(c in "01234567" for c in text):
        try:
            value = int(text, 8)
        except ValueError:
            return None
        return value if value <= 0o7777 else None

    mode = current
    for clause in text.split(","):
        i = 0
        classes = ""
        while i < len(clause) and clause[i] in "ugoa":
            classes += clause[i]
            i += 1
        if i >= len(clause) or clause[i] not in "+-=":
            return None
        action = clause[i]
        i += 1
        perms = clause[i:]
        if not all(c in "rwx" for c in perms):
            return None
        class_mask = 0
        for c in classes or "a":
            class_mask |= _MODE_CLASS_BITS[c]
        perm_mask = 0
        for c in perms:
            perm_mask |= _MODE_PERM_BITS[c]
        bits = class_mask & perm_mask
        if action == "+":
            mode |= bits
        elif action == "-":
            mode &= ~bits
        else:
            mode = (mode & ~class_mask) | bits
    return mode


def parse_owner(text: str) -> tuple[int | str | None, int | str | None]:
    """Parse a chown OWNER[:GROUP] argument.

    Numeric ids become ints; names are kept as strings (mirage has no
    user database; ownership is stored, not enforced).

    Args:
        text (str): the OWNER[:GROUP] operand as typed.

    Returns:
        tuple: (uid, gid); each is None when its part is absent.

    Example::

        parse_owner("1000:staff")  -> (1000, "staff")
        parse_owner("alice")       -> ("alice", None)
        parse_owner(":dev")        -> (None, "dev")
    """
    owner, sep, group = text.partition(":")
    uid = (int(owner) if owner.isdigit() else owner) if owner else None
    gid = (int(group) if group.isdigit() else group) if sep and group else None
    return uid, gid


def parse_touch_stamp(t: str | None, d: str | None) -> str | None:
    """Resolve touch -t/-d into an ISO timestamp.

    Args:
        t (str | None): POSIX ``[[CC]YY]MMDDhhmm[.ss]`` stamp.
        d (str | None): date string (ISO 8601 or ``YYYY-MM-DD hh:mm:ss``).

    Returns:
        str | None: ISO timestamp, or None when neither flag is given.

    Raises:
        ValueError: when the stamp does not parse.

    Example::

        parse_touch_stamp("202601021530", None) -> "2026-01-02T15:30:00+00:00"
        parse_touch_stamp(None, "2026-01-02")   -> "2026-01-02T00:00:00+00:00"
    """
    if t is not None:
        raw = t
        seconds = 0
        if "." in raw:
            raw, _, sec_text = raw.partition(".")
            if len(sec_text) != 2 or not sec_text.isdigit():
                raise ValueError(t)
            seconds = int(sec_text)
        if not raw.isdigit():
            raise ValueError(t)
        if len(raw) == 8:
            raw = f"{time.gmtime().tm_year:04d}" + raw
        elif len(raw) == 10:
            century = "20" if int(raw[:2]) < 69 else "19"
            raw = century + raw
        if len(raw) != 12:
            raise ValueError(t)
        dt = datetime(int(raw[0:4]),
                      int(raw[4:6]),
                      int(raw[6:8]),
                      int(raw[8:10]),
                      int(raw[10:12]),
                      seconds,
                      tzinfo=timezone.utc)
        return dt.isoformat()
    if d is not None:
        dt = datetime.fromisoformat(d.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _split_value_flags(
    args: list[str | PathSpec],
    boolean: str,
    valued: str,
) -> tuple[set[str], dict[str, str], list[str | PathSpec], str | None]:
    """Split leading flags where some take a value (``-t STAMP``).

    Args:
        args (list[str | PathSpec]): args after the command name.
        boolean (str): single-letter flags with no value.
        valued (str): single-letter flags that consume the next arg.

    Returns:
        tuple: (bool flags, valued flags, operands, bad option or None).
    """
    flags: set[str] = set()
    values: dict[str, str] = {}
    operands: list[str | PathSpec] = []
    parsing = True
    i = 0
    while i < len(args):
        arg = args[i]
        s = arg.virtual if isinstance(arg, PathSpec) else str(arg)
        if parsing and s == "--":
            parsing = False
            i += 1
            continue
        if parsing and s != "-" and len(s) >= 2 and s.startswith(
                "-") and not s.startswith("--"):
            body = s[1:]
            bad = next((c for c in body if c not in boolean + valued), None)
            if bad is not None:
                return flags, values, operands, bad
            for j, c in enumerate(body):
                if c in boolean:
                    flags.add(c)
                    continue
                rest = body[j + 1:]
                if rest:
                    values[c] = rest
                elif i + 1 < len(args):
                    i += 1
                    nxt = args[i]
                    values[c] = (nxt.raw_path or nxt.virtual) if isinstance(
                        nxt, PathSpec) else str(nxt)
                break
            i += 1
            continue
        parsing = False
        operands.append(arg)
        i += 1
    return flags, values, operands, None


async def _expand_operands(
    namespace: Namespace,
    operands: list[str | PathSpec],
) -> list[PathSpec]:
    """Coerce operands to PathSpec and expand glob patterns per mount.

    Args:
        namespace (Namespace): addressing authority (mount lookup).
        operands (list[str | PathSpec]): positional operands.
    """
    out: list[PathSpec] = []
    for item in operands:
        spec = item if isinstance(item, PathSpec) else PathSpec.from_str_path(
            str(item))
        if spec.pattern:
            mount = namespace.mount_for(spec.virtual)
            expanded = await mount.resource.resolve_glob(
                [spec], mount.prefix.rstrip("/"))
            out.extend(p for p in expanded if isinstance(p, PathSpec))
            continue
        out.append(spec)
    return out


def _read_only_error(cmd: str, namespace: Namespace, path: PathSpec) -> str:
    """Render the mirage read-only refusal for a metadata write.

    Args:
        cmd (str): command name.
        namespace (Namespace): addressing authority (mount lookup).
        path (PathSpec): the refused path.
    """
    prefix = namespace.mount_for(path.virtual).prefix
    return f"{cmd}: read-only mount at {prefix}\n"


async def _setattr_via(
    namespace: Namespace,
    dispatch: Callable,
    path: PathSpec,
    **fields: object,
) -> None:
    """Apply attributes natively when the mount supports setattr, else
    into the namespace overlay.

    Args:
        namespace (Namespace): addressing authority (overlay home).
        dispatch (Callable): op dispatcher.
        path (PathSpec): target path (already link-resolved).
    """
    mount = namespace.mount_for(path.virtual)
    if mount.supports_op("setattr", path.virtual):
        await dispatch("setattr", path, **fields)
        return
    # The mount has no setattr op (API backend): store in the overlay,
    # which is durable, snapshot-captured namespace state.
    mtime = fields.pop("mtime", None)
    epoch: float | None = None
    if isinstance(mtime, str):
        epoch = datetime.fromisoformat(mtime).timestamp()
    namespace.set_attrs(path.virtual, mtime=epoch, **fields)


async def handle_chmod(
    namespace: Namespace,
    dispatch: Callable,
    args: list[str | PathSpec],
) -> _Result:
    """chmod MODE FILE...: set permission bits via setattr.

    Follows symlinks (GNU chmod always dereferences). Stored, not
    enforced: mount mode does real access control.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (Callable): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = _split_value_flags(args, "Rvf", "")
    if bad is not None:
        return _error("chmod", f"chmod: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return _error("chmod", "chmod: missing operand\n", 2)
    mode_text = operands[0]
    mode_text = mode_text.virtual if isinstance(mode_text,
                                                PathSpec) else str(mode_text)
    if "R" in flags:
        return _error("chmod", "chmod: -R is not supported\n", 2)
    if parse_mode(mode_text, 0) is None:
        return _error("chmod", f"chmod: invalid mode: '{mode_text}'\n", 1)

    exit_code = 0
    errors: list[str] = []
    for target in await _expand_operands(namespace, operands[1:]):
        try:
            virtual = namespace.follow(target.virtual)
        except CycleError:
            errors.append(f"chmod: cannot access '{target.display}': "
                          f"Too many levels of symbolic links\n")
            exit_code = 1
            continue
        resolved = PathSpec.from_str_path(virtual)
        try:
            stat, _ = await dispatch("stat", resolved)
        except FileNotFoundError:
            errors.append(f"chmod: cannot access '{target.display}': "
                          f"No such file or directory\n")
            exit_code = 1
            continue
        current = stat.mode if stat.mode is not None else 0o644
        new_mode = parse_mode(mode_text, current)
        if new_mode is None:
            return _error("chmod", f"chmod: invalid mode: '{mode_text}'\n", 1)
        try:
            await _setattr_via(namespace, dispatch, resolved, mode=new_mode)
        except PermissionError:
            errors.append(_read_only_error("chmod", namespace, resolved))
            exit_code = 1
    if errors:
        err = "".join(errors).encode()
        return None, IOResult(exit_code=exit_code,
                              stderr=err), ExecutionNode(command="chmod",
                                                         exit_code=exit_code,
                                                         stderr=err)
    return _ok("chmod")


async def handle_chown(
    namespace: Namespace,
    dispatch: Callable,
    args: list[str | PathSpec],
) -> _Result:
    """chown OWNER[:GROUP] FILE...: set ownership via setattr.

    Ownership is stored, not enforced (mirage has no user model); names
    are kept verbatim, numeric ids become ints.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (Callable): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = _split_value_flags(args, "Rvfh", "")
    if bad is not None:
        return _error("chown", f"chown: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return _error("chown", "chown: missing operand\n", 2)
    if "R" in flags:
        return _error("chown", "chown: -R is not supported\n", 2)
    owner_text = operands[0]
    owner_text = owner_text.virtual if isinstance(
        owner_text, PathSpec) else str(owner_text)
    uid, gid = parse_owner(owner_text)
    if uid is None and gid is None:
        return _error("chown", f"chown: invalid spec: '{owner_text}'\n", 1)

    no_deref = "h" in flags
    exit_code = 0
    errors: list[str] = []
    for target in await _expand_operands(namespace, operands[1:]):
        if no_deref and namespace.is_link(target.virtual):
            namespace.set_attrs(target.virtual, uid=uid, gid=gid)
            continue
        try:
            virtual = namespace.follow(target.virtual)
        except CycleError:
            errors.append(f"chown: cannot access '{target.display}': "
                          f"Too many levels of symbolic links\n")
            exit_code = 1
            continue
        resolved = PathSpec.from_str_path(virtual)
        try:
            await dispatch("stat", resolved)
        except FileNotFoundError:
            errors.append(f"chown: cannot access '{target.display}': "
                          f"No such file or directory\n")
            exit_code = 1
            continue
        try:
            await _setattr_via(namespace, dispatch, resolved, uid=uid, gid=gid)
        except PermissionError:
            errors.append(_read_only_error("chown", namespace, resolved))
            exit_code = 1
    if errors:
        err = "".join(errors).encode()
        return None, IOResult(exit_code=exit_code,
                              stderr=err), ExecutionNode(command="chown",
                                                         exit_code=exit_code,
                                                         stderr=err)
    return _ok("chown")


async def handle_touch(
    namespace: Namespace,
    dispatch: Callable,
    args: list[str | PathSpec],
) -> _Result:
    """touch: set access/modification times, creating missing files.

    GNU flags: -a/-m select which times, -c no-create, -h no-dereference
    (writes the link node's own mtime), -t STAMP / -d STRING supply the
    time, -r FILE copies times from a reference file.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (Callable): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, values, operands, bad = _split_value_flags(args, "acmh", "tdr")
    if bad is not None:
        return _error("touch", f"touch: invalid option -- '{bad}'\n", 2)
    if not operands:
        return _error("touch", "touch: missing file operand\n", 1)

    try:
        stamp = parse_touch_stamp(values.get("t"), values.get("d"))
    except ValueError as exc:
        return _error("touch", f"touch: invalid date format '{exc}'\n", 1)
    if stamp is None and "r" in values:
        ref = PathSpec.from_str_path(values["r"])
        try:
            ref_stat, _ = await dispatch("stat", ref)
        except FileNotFoundError:
            return _error(
                "touch", f"touch: failed to get attributes of "
                f"'{values['r']}': No such file or directory\n")
        stamp = ref_stat.modified
    if stamp is None:
        stamp = _now_iso()

    set_atime = "a" in flags or "m" not in flags
    set_mtime = "m" in flags or "a" not in flags

    exit_code = 0
    errors: list[str] = []
    writes: dict[str, bytes] = {}
    for target in await _expand_operands(namespace, operands):
        if namespace.is_mount_root(target.virtual):
            errors.append(f"touch: cannot touch '{target.display}': "
                          f"Is a directory\n")
            exit_code = 1
            continue
        if "h" in flags and namespace.is_link(target.virtual):
            epoch = datetime.fromisoformat(stamp).timestamp()
            namespace.set_attrs(target.virtual, mtime=epoch)
            continue
        try:
            virtual = namespace.follow(target.virtual)
        except CycleError:
            errors.append(f"touch: cannot touch '{target.display}': "
                          f"Too many levels of symbolic links\n")
            exit_code = 1
            continue
        resolved = PathSpec.from_str_path(virtual)
        try:
            try:
                await dispatch("stat", resolved)
            except FileNotFoundError:
                if "c" in flags:
                    continue
                await dispatch("write", resolved, data=b"")
                writes[resolved.virtual] = b""
            fields: dict[str, object] = {}
            if set_atime:
                fields["atime"] = stamp
            if set_mtime:
                fields["mtime"] = stamp
            await _setattr_via(namespace, dispatch, resolved, **fields)
        except PermissionError:
            errors.append(_read_only_error("touch", namespace, resolved))
            exit_code = 1
    io = IOResult(exit_code=exit_code, writes=writes)
    if errors:
        io.stderr = "".join(errors).encode()
    return None, io, ExecutionNode(command="touch",
                                   exit_code=exit_code,
                                   stderr=io.stderr if errors else None)
