// The calls in gh 2.85.0's pkg/search (MIT; see
// licenses/third_party/gh.txt).

use super::client::{Account, Result, github_request_response};
use super::json::Json;

/// A bounded REST search, following the server's pagination.
pub(crate) async fn search(
    account: &Account,
    kind: &str,
    query: &str,
    limit: i64,
    sort: Option<&str>,
    order: Option<&str>,
) -> Result<Vec<Json>> {
    let accept = if kind == "code" {
        "application/vnd.github.text-match+json"
    } else {
        "application/vnd.github.v3+json"
    };
    let headers = [("Accept".to_owned(), accept.to_owned())];
    let mut rows = Vec::new();
    let mut page = 1u64;
    while (rows.len() as i64) < limit {
        let mut params = vec![
            ("q".to_owned(), query.to_owned()),
            ("per_page".to_owned(), limit.min(100).to_string()),
            ("page".to_owned(), page.to_string()),
        ];
        if kind == "issues" {
            params.push(("advanced_search".to_owned(), "true".to_owned()));
        }
        if let Some(sort) = sort {
            params.push(("sort".to_owned(), sort.to_owned()));
        }
        if let Some(order) = order {
            params.push(("order".to_owned(), order.to_owned()));
        }
        params.sort();
        let response = github_request_response(
            account,
            "GET",
            &format!("/search/{kind}"),
            None,
            &params,
            &headers,
        )
        .await?;
        let next = response
            .headers
            .get("link")
            .is_some_and(|link| link.contains(r#"rel="next""#));
        let body = response.data.into_json();
        let items = body.get("items");
        if !matches!(items, Json::Arr(_) | Json::Null) && body.as_obj().is_some() {
            return super::client::value("invalid search response: items must be an array");
        }
        let items = items.items();
        let room = usize::try_from(limit).unwrap_or(usize::MAX) - rows.len();
        rows.extend(items.iter().take(room).cloned());
        if items.is_empty() || !next {
            break;
        }
        page += 1;
    }
    Ok(rows)
}
