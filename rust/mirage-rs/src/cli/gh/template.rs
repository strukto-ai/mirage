// Follows go-gh v2.13.0's template package and Go 1.25.5's text/template
// (MIT and BSD-3-Clause; see go-gh.txt and go.txt in licenses/third_party/).

//! Go-style templates for `--template`: actions, pipelines and blocks.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::core::github::client::{Result, value};
use crate::core::github::json::{Json, float_text, quoted};

type Variables = HashMap<String, Rc<RefCell<Json>>>;

fn text(item: &Json) -> String {
    match item {
        Json::Null => "<no value>".to_owned(),
        Json::Str(content) => content.clone(),
        Json::Bool(flag) => flag.to_string(),
        Json::Int(number) => number.to_string(),
        Json::Float(number) => float_text(*number),
        Json::Arr(items) => format!("[{}]", items.iter().map(text).collect::<Vec<_>>().join(" ")),
        Json::Obj(obj) => {
            let mut pairs: Vec<&(String, Json)> = obj.iter().collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            format!(
                "map[{}]",
                pairs
                    .into_iter()
                    .map(|(key, item)| format!("{key}:{}", text(item)))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        }
    }
}

fn is_integer(token: &str) -> bool {
    let digits = token.strip_prefix('-').unwrap_or(token);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn lookup(token: &str, dot: &Json, root: &Json, variables: &Variables) -> Result<Json> {
    if token.starts_with('"') {
        return Json::parse(token.as_bytes()).or_else(value);
    }
    if let Some(inner) = token.strip_prefix('`') {
        return Ok(inner.strip_suffix('`').unwrap_or(inner).into());
    }
    if token == "true" || token == "false" {
        return Ok((token == "true").into());
    }
    if is_integer(token) {
        return Ok(token.parse::<i128>().map_or(Json::Null, Json::Int));
    }
    if token == "." {
        return Ok(dot.clone());
    }
    let (mut current, path) = if token.starts_with('$') {
        let (name, path) = token.split_once('.').unwrap_or((token, ""));
        if name == "$" {
            (root.clone(), path)
        } else {
            match variables.get(name) {
                Some(cell) => (cell.borrow().clone(), path),
                None => return value(format!(r#"template: undefined variable "{name}""#)),
            }
        }
    } else {
        (dot.clone(), token.trim_start_matches('.'))
    };
    for key in path.split('.').filter(|key| !key.is_empty()) {
        current = current.get(key).clone();
    }
    Ok(current)
}

fn format_args(format: &str, args: &[Json]) -> String {
    let mut out = String::new();
    let mut values = args.iter();
    let mut chars = format.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' || !chars.peek().is_some_and(|next| "%svdqf".contains(*next)) {
            out.push(c);
            continue;
        }
        let verb = chars.next().unwrap_or('%');
        if verb == '%' {
            out.push('%');
            continue;
        }
        let item = values.next().cloned().unwrap_or_default();
        match verb {
            'q' => out.push_str(&item.dump()),
            'f' => {
                let number = match &item {
                    Json::Int(number) => *number as f64,
                    Json::Float(number) => *number,
                    Json::Str(content) => content.parse().unwrap_or(0.0),
                    _ => 0.0,
                };
                out.push_str(&format!("{number:.6}"));
            }
            _ => out.push_str(&text(&item)),
        }
    }
    out
}

fn contains(needle: &Json, within: &Json) -> bool {
    match within {
        Json::Str(content) => content.contains(&text(needle)),
        Json::Arr(items) => items.contains(needle),
        Json::Obj(obj) => obj.has(&text(needle)),
        _ => false,
    }
}

fn truncated(width: i128, content: &str) -> String {
    let count = content.chars().count() as i128;
    if count <= width {
        return content.to_owned();
    }
    let keep = (width - 3).max(0) as usize;
    let dots = width.clamp(0, 3) as usize;
    let mut out: String = content.chars().take(keep).collect();
    out.push_str(&".".repeat(dots));
    out
}

fn call(name: &str, args: &[Json]) -> Result<Json> {
    let first = args.first().unwrap_or(&Json::Null);
    let second = args.get(1).unwrap_or(&Json::Null);
    Ok(match name {
        "len" => match first {
            Json::Str(content) => (content.chars().count() as i64).into(),
            Json::Arr(items) => (items.len() as i64).into(),
            Json::Obj(obj) => (obj.iter().count() as i64).into(),
            _ => return value("template: error calling len: len of nil pointer"),
        },
        "join" => second
            .items()
            .iter()
            .map(text)
            .collect::<Vec<_>>()
            .join(&text(first))
            .into(),
        "pluck" => Json::Arr(
            second
                .items()
                .iter()
                .map(|row| row.get(&text(first)).clone())
                .collect(),
        ),
        "print" => args.iter().map(text).collect::<String>().into(),
        "println" => format!("{}\n", args.iter().map(text).collect::<Vec<_>>().join(" ")).into(),
        "printf" => format_args(&text(first), args.get(1..).unwrap_or(&[])).into(),
        "index" => {
            let mut current = first.clone();
            for key in args.get(1..).unwrap_or(&[]) {
                current = match (&current, key) {
                    (Json::Arr(items), Json::Int(at)) => {
                        match usize::try_from(*at).ok().and_then(|at| items.get(at)) {
                            Some(item) => item.clone(),
                            None => return value("template: index out of range"),
                        }
                    }
                    (Json::Obj(obj), key) => match obj.find(&text(key)) {
                        Some(item) => item.clone(),
                        None => return value(format!("template: no key {}", quoted(&text(key)))),
                    },
                    _ => return value("template: cannot index"),
                };
            }
            current
        }
        "eq" => args
            .get(1..)
            .unwrap_or(&[])
            .iter()
            .any(|item| first == item)
            .into(),
        "ne" => (first != second).into(),
        "not" => (!first.truthy()).into(),
        "and" => args.iter().all(Json::truthy).into(),
        "or" => args.iter().any(Json::truthy).into(),
        "color" | "autocolor" | "hyperlink" => args.last().cloned().unwrap_or_default(),
        "truncate" => truncated(first.as_int().unwrap_or(0), &text(second)).into(),
        "contains" => contains(first, second).into(),
        "hasPrefix" => text(second).starts_with(&text(first)).into(),
        "hasSuffix" => text(second).ends_with(&text(first)).into(),
        _ => return value(format!(r#"template: function "{name}" not defined"#)),
    })
}

fn tokens(expression: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = expression.char_indices().peekable();
    while let Some(&(at, c)) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else if c == '|' {
            chars.next();
            out.push("|".to_owned());
        } else if c == '"' {
            chars.next();
            let mut end = expression.len();
            let mut escaped = false;
            for (index, inner) in chars.by_ref() {
                if escaped {
                    escaped = false;
                } else if inner == '\\' {
                    escaped = true;
                } else if inner == '"' {
                    end = index + 1;
                    break;
                }
            }
            out.push(expression[at..end].to_owned());
        } else if c == '`' {
            chars.next();
            let mut end = expression.len();
            for (index, inner) in chars.by_ref() {
                if inner == '`' {
                    end = index + 1;
                    break;
                }
            }
            out.push(expression[at..end].to_owned());
        } else {
            let mut end = expression.len();
            while let Some(&(index, inner)) = chars.peek() {
                if inner.is_whitespace() || inner == '|' {
                    end = index;
                    break;
                }
                chars.next();
            }
            out.push(expression[at..end].to_owned());
        }
    }
    out
}

fn is_operand(token: &str) -> bool {
    token.starts_with(['.', '$', '"', '`'])
        || token == "true"
        || token == "false"
        || is_integer(token)
}

fn evaluate(expression: &str, dot: &Json, root: &Json, variables: &Variables) -> Result<Json> {
    let words = tokens(expression);
    let mut parts: Vec<Vec<String>> = vec![Vec::new()];
    for token in words {
        if token == "|" {
            parts.push(Vec::new());
        } else if let Some(last) = parts.last_mut() {
            last.push(token);
        }
    }
    let mut current = Json::Null;
    for (at, part) in parts.iter().enumerate() {
        if part.is_empty() {
            return value("template: empty pipeline");
        }
        let mut args = part[1..]
            .iter()
            .map(|token| lookup(token, dot, root, variables))
            .collect::<Result<Vec<_>>>()?;
        if at > 0 {
            args.push(current.clone());
        }
        current = if part.len() == 1 && at == 0 && is_operand(&part[0]) {
            lookup(&part[0], dot, root, variables)?
        } else {
            call(&part[0], &args)?
        };
    }
    Ok(current)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn variable(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix('$')?;
    let end = rest.find(|c| !is_word(c)).unwrap_or(rest.len());
    (end > 0).then(|| text.split_at(end + 1))
}

/// `$x := ...`, `$k, $v := ...` or `$x = ...`: the names, the pipeline,
/// and whether it assigns.
fn declaration(expression: &str) -> (Vec<String>, String, bool) {
    let none = || (Vec::new(), expression.to_owned(), false);
    let Some((first, rest)) = variable(expression) else {
        return none();
    };
    let mut names = vec![first.to_owned()];
    let mut rest = rest.trim_start();
    if let Some(after) = rest.strip_prefix(',') {
        let Some((second, tail)) = variable(after.trim_start()) else {
            return none();
        };
        names.push(second.to_owned());
        rest = tail.trim_start();
    }
    let (assign, tail) = if let Some(tail) = rest.strip_prefix(":=") {
        (false, tail)
    } else if let Some(tail) = rest.strip_prefix('=') {
        (true, tail)
    } else {
        return none();
    };
    (names, tail.trim_start().to_owned(), assign)
}

enum Token {
    Text(String),
    Action(String),
}

fn lex(template: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut rest = template;
    let mut trim = false;
    while let Some(open) = rest.find("{{") {
        let inside = &rest[open + 2..];
        let Some(close) = inside.find("}}") else {
            break;
        };
        let mut head = rest[..open].to_owned();
        if trim {
            head = head.trim_start().to_owned();
        }
        let mut body = &inside[..close];
        let left = body.starts_with('-');
        if left {
            body = &body[1..];
            head = head.trim_end().to_owned();
        }
        let body = body.trim_start();
        let (body, right) = match body.strip_suffix('-') {
            Some(cut) => (cut, true),
            None => (body, false),
        };
        out.push(Token::Text(head));
        out.push(Token::Action(body.trim_end().to_owned()));
        trim = right;
        rest = &inside[close + 2..];
    }
    out.push(Token::Text(if trim {
        rest.trim_start().to_owned()
    } else {
        rest.to_owned()
    }));
    out
}

struct Renderer<'a> {
    tokens: &'a [Token],
    root: &'a Json,
}

impl Renderer<'_> {
    fn block_end(&self, start: usize, stop: usize) -> Result<(usize, Option<usize>)> {
        let mut depth = 1;
        let mut alternate = None;
        let mut cursor = start;
        while cursor < stop {
            if let Token::Action(action) = &self.tokens[cursor] {
                let nested = action.split(' ').next().unwrap_or("");
                if matches!(nested, "range" | "if" | "with") {
                    depth += 1;
                } else if nested == "end" {
                    depth -= 1;
                    if depth == 0 {
                        return Ok((cursor, alternate));
                    }
                } else if nested == "else" && depth == 1 {
                    alternate = Some(cursor);
                }
            }
            cursor += 1;
        }
        value("template: unexpected EOF")
    }

    fn render(
        &self,
        start: usize,
        stop: usize,
        dot: &Json,
        variables: &mut Variables,
    ) -> Result<String> {
        let mut output = String::new();
        let mut at = start;
        while at < stop {
            let action = match &self.tokens[at] {
                Token::Text(content) => {
                    output.push_str(content);
                    at += 1;
                    continue;
                }
                Token::Action(action) => action,
            };
            at += 1;
            let (command, expression) = action.split_once(' ').unwrap_or((action, ""));
            if matches!(command, "range" | "if" | "with") {
                let (cursor, alternate) = self.block_end(at, stop)?;
                let (names, pipeline, _) = declaration(expression);
                if names.len() > 1 && command != "range" {
                    return value(format!("template: too many declarations in {command}"));
                }
                let resolved = evaluate(&pipeline, dot, self.root, variables)?;
                let body_end = alternate.unwrap_or(cursor);
                let mut scope = variables.clone();
                if command != "range" {
                    if let Some(name) = names.first() {
                        scope.insert(name.clone(), Rc::new(RefCell::new(resolved.clone())));
                    }
                }
                if command == "range" && resolved.truthy() {
                    let entries: Vec<(Json, Json)> = match &resolved {
                        Json::Obj(obj) => {
                            let mut pairs: Vec<&(String, Json)> = obj.iter().collect();
                            pairs.sort_by(|a, b| a.0.cmp(&b.0));
                            pairs
                                .into_iter()
                                .map(|(key, item)| (Json::from(key), item.clone()))
                                .collect()
                        }
                        other => other
                            .items()
                            .iter()
                            .enumerate()
                            .map(|(index, item)| (Json::Int(index as i128), item.clone()))
                            .collect(),
                    };
                    for (key, item) in entries {
                        let mut bound = variables.clone();
                        if names.len() == 2 {
                            bound.insert(names[0].clone(), Rc::new(RefCell::new(key)));
                        }
                        if let Some(last) = names.last() {
                            bound.insert(last.clone(), Rc::new(RefCell::new(item.clone())));
                        }
                        output.push_str(&self.render(at, body_end, &item, &mut bound)?);
                    }
                } else if resolved.truthy() && command != "range" {
                    let inner = if command == "with" { &resolved } else { dot };
                    output.push_str(&self.render(at, body_end, inner, &mut scope)?);
                } else if let Some(alternate) = alternate {
                    output.push_str(&self.render(alternate + 1, cursor, dot, &mut scope)?);
                }
                at = cursor + 1;
            } else if matches!(command, "end" | "else") {
                return value(format!("template: unexpected {command}"));
            } else {
                let (names, pipeline, assign) = declaration(action);
                let result = evaluate(&pipeline, dot, self.root, variables)?;
                match names.first() {
                    None => output.push_str(&text(&result)),
                    Some(name) if !assign => {
                        variables.insert(name.clone(), Rc::new(RefCell::new(result)));
                    }
                    Some(name) => match variables.get(name) {
                        Some(cell) => *cell.borrow_mut() = result,
                        None => {
                            return value(format!(r#"template: undefined variable "{name}""#));
                        }
                    },
                }
            }
        }
        Ok(output)
    }
}

/// Render structured output with Go-style actions, pipelines and blocks.
pub(crate) fn render_template(template: &str, root: &Json) -> Result<String> {
    let tokens = lex(template);
    let renderer = Renderer {
        tokens: &tokens,
        root,
    };
    renderer.render(0, tokens.len(), root, &mut HashMap::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(template: &str, data: &str) -> String {
        render_template(template, &Json::parse(data.as_bytes()).unwrap()).unwrap()
    }

    #[test]
    fn ranges_bind_their_dot_and_their_variables() {
        assert_eq!(
            render(
                r#"{{range .}}{{.n}},{{end}}|{{range $i, $r := .}}{{$i}}={{$r.n}};{{end}}"#,
                r#"[{"n":1},{"n":2}]"#
            ),
            "1,2,|0=1;1=2;"
        );
    }

    #[test]
    fn blocks_take_their_else_and_dashes_trim() {
        assert_eq!(
            render(
                r#"a  {{- if .x}}yes{{else}}no{{end -}}  b"#,
                r#"{"x":false}"#
            ),
            "anob"
        );
    }

    #[test]
    fn pipelines_pass_the_last_value_as_the_last_argument() {
        assert_eq!(
            render(
                r#"{{.t | truncate 5}} {{len .l}} {{join "," .l}}"#,
                r#"{"t":"abcdefgh","l":["x","y"]}"#
            ),
            "ab... 2 x,y"
        );
    }

    #[test]
    fn an_absent_value_prints_no_value() {
        assert_eq!(render("{{.missing}}", "{}"), "<no value>");
    }
}
