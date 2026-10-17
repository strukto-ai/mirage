import json
import re
from typing import Any

from mirage.commands.cli.builtin.gh.constants import (
    TEMPLATE_ACTION,
    TEMPLATE_DECLARATION,
    TEMPLATE_TOKEN,
)

Variables = dict[str, list[Any]]


def _text(value: Any) -> str:
    if value is None:
        return "<no value>"
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, list):
        return "[" + " ".join(_text(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "map["
            + " ".join(f"{k}:{_text(value[k])}" for k in sorted(value))
            + "]"
        )
    return str(value)


def _lookup(token: str, dot: Any, root: Any, variables: Variables) -> Any:
    if token.startswith('"'):
        return json.loads(token)
    if token.startswith("`"):
        return token[1:-1]
    if token in ("true", "false"):
        return token == "true"
    if re.fullmatch(r"-?\d+", token):
        return int(token)
    if token == ".":
        return dot
    path = token.lstrip(".")
    value = dot
    if token.startswith("$"):
        name, _, path = token.partition(".")
        if name != "$" and name not in variables:
            raise ValueError(f'template: undefined variable "{name}"')
        value = root if name == "$" else variables[name][0]
    for key in path.split("."):
        if not key:
            continue
        value = value.get(key) if isinstance(value, dict) else None
    return value


def _call(name: str, args: list[Any]) -> Any:
    if name == "len":
        return len(args[0])
    if name == "join":
        return str(args[0]).join(_text(x) for x in args[1])
    if name == "pluck":
        return [row.get(args[0]) for row in args[1]]
    if name in ("print", "println"):
        return (" " if name == "println" else "").join(
            _text(x) for x in args
        ) + ("\n" if name == "println" else "")
    if name == "printf":
        values = iter(args[1:])

        def format_value(match: re.Match[str]) -> str:
            flag = match[1]
            if flag == "%":
                return "%"
            value = next(values)
            if flag == "q":
                return json.dumps(value, ensure_ascii=False)
            if flag == "f":
                return f"{float(value):f}"
            return _text(value)

        return re.sub(r"%(%|s|v|d|q|f)", format_value, str(args[0]))
    if name == "index":
        value = args[0]
        for key in args[1:]:
            value = value[key]
        return value
    if name == "eq":
        return any(args[0] == value for value in args[1:])
    if name == "ne":
        return args[0] != args[1]
    if name == "not":
        return not args[0]
    if name in ("and", "or"):
        return all(args) if name == "and" else any(args)
    if name in ("color", "autocolor", "hyperlink"):
        return args[-1]
    if name == "truncate":
        n, text = int(args[0]), _text(args[1])
        return (
            text if len(text) <= n else text[: max(0, n - 3)] + "." * min(n, 3)
        )
    if name == "contains":
        return args[0] in args[1]
    if name == "hasPrefix":
        return str(args[1]).startswith(args[0])
    if name == "hasSuffix":
        return str(args[1]).endswith(args[0])
    raise ValueError(f'template: function "{name}" not defined')


def _evaluate(
    expression: str, dot: Any, root: Any, variables: Variables
) -> Any:
    tokens = TEMPLATE_TOKEN.findall(expression)
    parts: list[list[str]] = [[]]
    for token in tokens:
        if token == "|":
            parts.append([])
        else:
            parts[-1].append(token)
    value = None
    for i, part in enumerate(parts):
        if not part:
            raise ValueError("template: empty pipeline")
        args = [_lookup(token, dot, root, variables) for token in part[1:]]
        if i:
            args.append(value)
        value = (
            _lookup(part[0], dot, root, variables)
            if len(part) == 1
            and not i
            and (
                part[0].startswith((".", "$", '"', "`"))
                or part[0] in ("true", "false")
                or re.fullmatch(r"-?\d+", part[0])
            )
            else _call(part[0], args)
        )
    return value


def _declaration(expression: str) -> tuple[list[str], str, bool]:
    match = TEMPLATE_DECLARATION.fullmatch(expression)
    if match is None:
        return [], expression, False
    return (
        [name for name in match.group(1, 2) if name],
        match[4],
        match[3] == "=",
    )


def render_template(template: str, value: Any) -> str:
    """Render structured output with Go-style actions, pipelines and blocks.

    Args:
        template (str): output template.
        value (Any): selected JSON fields.
    """
    tokens: list[tuple[str, str]] = []
    end = 0
    trim = False
    for match in TEMPLATE_ACTION.finditer(template):
        text = template[end : match.start()]
        if trim:
            text = text.lstrip()
        if match[1]:
            text = text.rstrip()
        tokens.append(("text", text))
        tokens.append(("action", match[2]))
        trim = bool(match[3])
        end = match.end()
    tokens.append(
        ("text", template[end:].lstrip() if trim else template[end:])
    )

    def render(start: int, stop: int, dot: Any, variables: Variables) -> str:
        output = []
        i = start
        while i < stop:
            tag, action = tokens[i]
            i += 1
            if tag == "text":
                output.append(action)
                continue
            command, _, expression = action.partition(" ")
            if command in ("range", "if", "with"):
                depth, cursor, alternate = 1, i, None
                while cursor < stop:
                    if tokens[cursor][0] == "action":
                        nested = tokens[cursor][1].split(" ", 1)[0]
                        if nested in ("range", "if", "with"):
                            depth += 1
                        elif nested == "end":
                            depth -= 1
                            if depth == 0:
                                break
                        elif nested == "else" and depth == 1:
                            alternate = cursor
                    cursor += 1
                if depth:
                    raise ValueError("template: unexpected EOF")
                names, pipeline, _ = _declaration(expression)
                if len(names) > 1 and command != "range":
                    raise ValueError(
                        f"template: too many declarations in {command}"
                    )
                resolved = _evaluate(pipeline, dot, value, variables)
                body_end = alternate if alternate is not None else cursor
                scope = dict(variables)
                if names and command != "range":
                    scope[names[0]] = [resolved]
                if command == "range" and resolved:
                    entries = (
                        [(k, resolved[k]) for k in sorted(resolved)]
                        if isinstance(resolved, dict)
                        else enumerate(resolved)
                    )
                    for key, item in entries:
                        bound = dict(variables)
                        if len(names) == 2:
                            bound[names[0]] = [key]
                        if names:
                            bound[names[-1]] = [item]
                        output.append(render(i, body_end, item, bound))
                elif resolved:
                    output.append(
                        render(
                            i,
                            body_end,
                            resolved if command == "with" else dot,
                            scope,
                        )
                    )
                elif alternate is not None:
                    output.append(render(alternate + 1, cursor, dot, scope))
                i = cursor + 1
            elif command in ("end", "else"):
                raise ValueError(f"template: unexpected {command}")
            else:
                names, pipeline, assign = _declaration(action)
                result = _evaluate(pipeline, dot, value, variables)
                if not names:
                    output.append(_text(result))
                elif not assign:
                    variables[names[0]] = [result]
                elif names[0] in variables:
                    variables[names[0]][0] = result
                else:
                    raise ValueError(
                        f'template: undefined variable "{names[0]}"'
                    )
        return "".join(output)

    return render(0, len(tokens), value, {})
