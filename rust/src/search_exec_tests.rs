//! Unit tests for search_exec (request-to-config mapping and protocol backward compatibility).

use crate::protocol::{Request, Response};
use crate::search_exec::request_to_config;

#[test]
fn test_request_to_config_defaults_and_overrides() {
    let cfg1 = request_to_config(10, 0, false);
    assert_eq!(cfg1.primary_depth, 50);
    assert_eq!(cfg1.secondary_depth, 50);
    assert_eq!(cfg1.rrf_k, 60.0);
    assert_eq!(cfg1.rerank_top_n, 50);
    assert!(!cfg1.rerank);

    let cfg2 = request_to_config(10, 0, true);
    assert!(cfg2.rerank);
    assert_eq!(cfg2.primary_depth, 50);

    let cfg3 = request_to_config(20, 60, false);
    assert_eq!(cfg3.primary_depth, 80);
    assert_eq!(cfg3.secondary_depth, 80);

    let cfg4 = request_to_config(10, 0, Some(true));
    assert!(cfg4.rerank);

    let cfg5 = request_to_config(10, 0, None);
    assert!(!cfg5.rerank);
}

#[test]
fn test_protocol_old_search_json_deserializes() {
    let old_req_json = r#"{
        "Search": {
            "project_root": "/tmp/test",
            "query": "hello world",
            "languages": null,
            "paths": null,
            "limit": 10,
            "offset": 0
        }
    }"#;
    let req: Request = serde_json::from_str(old_req_json)
        .expect("old Request::Search JSON must deserialize");
    match req {
        Request::Search {
            project_root,
            query,
            languages,
            paths,
            limit,
            offset,
            rerank,
            mode,
        } => {
            assert_eq!(project_root, "/tmp/test");
            assert_eq!(query, "hello world");
            assert_eq!(languages, None);
            assert_eq!(paths, None);
            assert_eq!(limit, 10);
            assert_eq!(offset, 0);
            assert_eq!(rerank, None);
            assert_eq!(mode, None);
        }
        _ => panic!("expected Request::Search"),
    }

    let old_resp_json = r#"{
        "Search": {
            "success": true,
            "results": [],
            "total_returned": 0,
            "offset": 0,
            "message": null
        }
    }"#;
    let resp: Response = serde_json::from_str(old_resp_json)
        .expect("old Response::Search JSON must deserialize");
    match resp {
        Response::Search {
            success,
            results,
            total_returned,
            offset,
            message,
            rerank_status,
            primary_only,
        } => {
            assert!(success);
            assert!(results.is_empty());
            assert_eq!(total_returned, 0);
            assert_eq!(offset, 0);
            assert_eq!(message, None);
            assert_eq!(rerank_status, None);
            assert_eq!(primary_only, None);
        }
        _ => panic!("expected Response::Search"),
    }
}

#[test]
fn test_protocol_roundtrip_msgpack() {
    let old_req_val = serde_json::json!({
        "Search": {
            "project_root": "/tmp/test",
            "query": "hello world",
            "languages": null,
            "paths": null,
            "limit": 10,
            "offset": 0
        }
    });
    let packed = rmp_serde::to_vec_named(&old_req_val).expect("pack named map");
    let req: Request = rmp_serde::from_slice(&packed).expect("unpack old Request");
    match req {
        Request::Search { rerank, mode, .. } => {
            assert_eq!(rerank, None);
            assert_eq!(mode, None);
        }
        _ => panic!("expected Request::Search"),
    }
}
