// Link-header paging as gh 2.85.0's pkg/cmd/api finds the next page (MIT; see
// licenses/third_party/gh.txt).

use super::client::{Account, Pairs, Result, github_request_response};
use super::json::Json;

/// A bounded REST list, by GitHub's page and per_page; the first request
/// names no page, as gh's that follow the Link header send it.
pub(crate) async fn github_pages(
    account: &Account,
    path: &str,
    params: &Pairs,
    limit: i64,
    key: Option<&str>,
    include: impl Fn(&Json) -> bool + Send,
) -> Result<Vec<Json>> {
    paged(account, path, params, limit, key, include, false).await
}

/// `github_pages` for the lists gh pages by number from the first request.
pub(crate) async fn github_numbered_pages(
    account: &Account,
    path: &str,
    params: &Pairs,
    limit: i64,
    key: Option<&str>,
    include: impl Fn(&Json) -> bool + Send,
) -> Result<Vec<Json>> {
    paged(account, path, params, limit, key, include, true).await
}

async fn paged(
    account: &Account,
    path: &str,
    params: &Pairs,
    limit: i64,
    key: Option<&str>,
    include: impl Fn(&Json) -> bool + Send,
    numbered: bool,
) -> Result<Vec<Json>> {
    if limit < 1 {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    let mut page = 1u64;
    let size = limit.min(100);
    while (rows.len() as i64) < limit {
        let mut query = params.to_vec();
        query.insert(0, ("per_page".to_owned(), size.to_string()));
        if numbered || page > 1 {
            query.push(("page".to_owned(), page.to_string()));
        }
        let data = github_request_response(account, "GET", path, None, &query, &[])
            .await?
            .data
            .into_json();
        let payload = match (key, data.as_obj()) {
            (Some(key), Some(obj)) => obj.get(key).clone(),
            _ => data,
        };
        let batch = payload.items();
        rows.extend(
            batch
                .iter()
                .filter(|item| item.as_obj().is_some() && include(item))
                .cloned(),
        );
        if (batch.len() as i64) < size {
            break;
        }
        page += 1;
    }
    rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    Ok(rows)
}
