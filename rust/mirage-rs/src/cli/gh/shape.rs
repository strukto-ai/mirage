// Marshals as gh 2.85.0's types do under Go 1.25.5's encoding/json (MIT
// and BSD-3-Clause; see licenses/third_party/gh.txt and go.txt).

use crate::core::github::json::{Json, Obj};

pub(crate) const ZERO_TIME: &str = "0001-01-01T00:00:00Z";

/// The Go type gh decodes a field into, which decides how it prints.
#[derive(Clone)]
pub(crate) enum Shape {
    Str,
    Int,
    Bool,
    Time,
    Raw,
    Author,
    Reactions,
    Owner,
    Struct(Vec<(&'static str, Shape, Option<&'static str>)>, bool),
    List(Box<Shape>),
    OrNull(Box<Shape>),
}

pub(crate) fn strukt(fields: Vec<(&'static str, Shape)>) -> Shape {
    Shape::Struct(
        fields
            .into_iter()
            .map(|(name, shape)| (name, shape, None))
            .collect(),
        false,
    )
}

pub(crate) fn pointer(fields: Vec<(&'static str, Shape)>) -> Shape {
    Shape::Struct(
        fields
            .into_iter()
            .map(|(name, shape)| (name, shape, None))
            .collect(),
        true,
    )
}

pub(crate) fn list_of(item: Shape) -> Shape {
    Shape::List(Box::new(item))
}

pub(crate) fn or_null(item: Shape) -> Shape {
    Shape::OrNull(Box::new(item))
}

/// gh's Author: a bot is the one with no id.
fn author(value: &Json) -> Json {
    let id = value.get("id").text();
    let login = value.get("login").text();
    let mut out = Obj::new();
    if id.is_empty() {
        out.set("is_bot", true);
        out.set("login", format!("app/{login}"));
        return Json::Obj(out);
    }
    out.set("id", id);
    out.set("is_bot", false);
    out.set("login", login);
    out.set("name", value.get("name").text());
    Json::Obj(out)
}

/// gh's ReactionGroups: only the groups someone reacted with.
fn reactions(value: &Json) -> Json {
    let group = strukt(vec![
        ("content", Shape::Str),
        ("users", strukt(vec![("totalCount", Shape::Int)])),
    ]);
    Json::Arr(
        value
            .items()
            .iter()
            .filter(|item| item.get("users").get("totalCount").as_int().unwrap_or(0) != 0)
            .map(|item| exported(item, &group))
            .collect(),
    )
}

/// gh's Owner, whose id and name are omitempty.
fn owner(value: &Json) -> Json {
    let mut out = Obj::new();
    if !value.get("id").text().is_empty() {
        out.set("id", value.get("id").clone());
    }
    if !value.get("name").text().is_empty() {
        out.set("name", value.get("name").clone());
    }
    out.set("login", value.get("login").text());
    Json::Obj(out)
}

/// One value as gh prints it once decoded into `shape`.
pub(crate) fn exported(value: &Json, shape: &Shape) -> Json {
    match shape {
        Shape::Str => value.text().into(),
        Shape::Int => value.as_int().unwrap_or(0).into(),
        Shape::Bool => value.as_bool().unwrap_or(false).into(),
        Shape::Time => value.as_str().unwrap_or(ZERO_TIME).into(),
        Shape::Raw => value.clone(),
        Shape::Author => author(value),
        Shape::Reactions => reactions(value),
        Shape::Owner => owner(value),
        Shape::List(item) => match value {
            Json::Arr(items) => Json::Arr(items.iter().map(|one| exported(one, item)).collect()),
            _ => Json::Null,
        },
        Shape::OrNull(item) => {
            if value.is_null() {
                Json::Null
            } else {
                exported(value, item)
            }
        }
        Shape::Struct(fields, nullable) => {
            if value.is_null() && *nullable {
                return Json::Null;
            }
            let mut out = Obj::new();
            for (name, inner, source) in fields {
                out.set(*name, exported(value.get(source.unwrap_or(name)), inner));
            }
            Json::Obj(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Json {
        Json::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn a_null_is_each_go_types_zero() {
        assert_eq!(exported(&Json::Null, &Shape::Str), Json::from(""));
        assert_eq!(exported(&Json::Null, &Shape::Int), Json::from(0i64));
        assert_eq!(exported(&Json::Null, &Shape::Bool), Json::from(false));
        assert_eq!(exported(&Json::Null, &Shape::Time), Json::from(ZERO_TIME));
        assert_eq!(exported(&Json::Null, &Shape::Raw), Json::Null);
    }

    #[test]
    fn a_bot_is_the_author_with_no_id() {
        assert_eq!(
            exported(&json(r#"{"login":"ci"}"#), &Shape::Author).dump(),
            r#"{"is_bot":true,"login":"app/ci"}"#
        );
        assert_eq!(
            exported(
                &json(r#"{"id":"U","login":"a","name":"A"}"#),
                &Shape::Author
            )
            .dump(),
            r#"{"id":"U","is_bot":false,"login":"a","name":"A"}"#
        );
    }

    #[test]
    fn reactions_nobody_made_are_dropped() {
        let value = json(
            r#"[{"content":"HEART","users":{"totalCount":0}},{"content":"LAUGH","users":{"totalCount":2}}]"#,
        );
        assert_eq!(
            exported(&value, &Shape::Reactions).dump(),
            r#"[{"content":"LAUGH","users":{"totalCount":2}}]"#
        );
    }

    #[test]
    fn a_pointer_stays_null_and_a_struct_fills_with_zeroes() {
        let fields = vec![("name", Shape::Str)];
        assert_eq!(exported(&Json::Null, &pointer(fields.clone())), Json::Null);
        assert_eq!(
            exported(&Json::Null, &strukt(fields)).dump(),
            r#"{"name":""}"#
        );
    }
}
