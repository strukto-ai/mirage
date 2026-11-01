use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Config {
    Equal {
        column: String,
        value: String,
    },
    Predicate {
        column: String,
        filters: Vec<(String, String)>,
        prefix: String,
    },
    Holding {
        columns: Vec<String>,
        texts: Vec<String>,
        ignore_case: bool,
        filters: Vec<(String, String)>,
    },
}

fn column(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn quote(value: &str) -> String {
    value.replace('\'', "''")
}

fn equal(name: &str, value: &str) -> String {
    let digits = value.strip_prefix('-').unwrap_or(value);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        format!("{} = {value}", column(name))
    } else {
        format!("{} = '{}'", column(name), quote(value))
    }
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let (filters, tail) = match config {
        Config::Equal { column, value } => {
            return Ok(Box::new(Query(Some(equal(&column, &value)))));
        }
        Config::Predicate {
            column: name,
            filters,
            prefix,
        } => {
            let tail = if name.is_empty() || prefix.is_empty() {
                None
            } else {
                let escaped = prefix
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
                Some(format!(
                    "CAST({} AS STRING) LIKE '{}%' ESCAPE '\\'",
                    column(&name),
                    quote(&escaped)
                ))
            };
            (filters, tail)
        }
        Config::Holding {
            columns,
            texts,
            ignore_case,
            filters,
        } => {
            let mut tests = Vec::new();
            for name in columns {
                for text in &texts {
                    tests.push(if ignore_case {
                        format!(
                            "lower({}) LIKE '%{}%'",
                            column(&name),
                            text.to_ascii_lowercase()
                        )
                    } else {
                        format!("{} LIKE '%{text}%'", column(&name))
                    });
                }
            }
            (filters, Some(format!("({})", tests.join(" OR "))))
        }
    };
    let mut parts: Vec<String> = filters
        .iter()
        .map(|(name, value)| equal(name, value))
        .collect();
    parts.extend(tail);
    Ok(Box::new(Query(Some(parts.join(" AND ")))))
}

struct Query(Option<String>);

impl Stream for Query {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !input.is_empty() {
            return Err(StreamError::new(
                "lance_query reads its operands from config",
            ));
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Some(text) = self.0.take() {
            out.extend_from_slice(text.as_bytes());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::open;
    use serde_json::json;

    #[test]
    fn clauses_keep_literals_and_filter_order() {
        for (config, expected) in [
            (
                json!({"op":"equal","column":"a`b","value":"x'y"}),
                "`a``b` = 'x''y'",
            ),
            (
                json!({"op":"equal","column":"id","value":"-012"}),
                "`id` = -012",
            ),
            (
                json!({"op":"equal","column":"id","value":"12\n"}),
                "`id` = '12\n'",
            ),
            (
                json!({"op":"predicate","column":"id","filters":[["z","1"],["a","x"]],"prefix":"a_%\\'"}),
                "`z` = 1 AND `a` = 'x' AND CAST(`id` AS STRING) LIKE 'a\\_\\%\\\\''%' ESCAPE '\\'",
            ),
            (
                json!({"op":"holding","columns":["a`b","c"],"texts":["Hello","WORLD"],"ignore_case":true,"filters":[["id","2"]]}),
                "`id` = 2 AND (lower(`a``b`) LIKE '%hello%' OR lower(`a``b`) LIKE '%world%' OR lower(`c`) LIKE '%hello%' OR lower(`c`) LIKE '%world%')",
            ),
            (
                json!({"op":"predicate","column":"","filters":[],"prefix":"x"}),
                "",
            ),
        ] {
            let mut stream = open("lance_query", &serde_json::to_vec(&config).unwrap()).unwrap();
            let mut out = Vec::new();
            stream.finish(&mut out).unwrap();
            stream.finish(&mut out).unwrap();
            assert_eq!(out, expected.as_bytes());
        }
        assert!(
            open(
                "lance_query",
                br#"{"op":"equal","column":"x","value":"y","unknown":1}"#
            )
            .is_err()
        );
    }
}
