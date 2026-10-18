//! 错误码与参数构造。FFGUI_* 是侧车自身的协议/参数错误；
//! 引擎错误码以 `E<数字>` 形式原样透传。

use serde_json::{Map, Value};

pub const ERR_PROTOCOL_VERSION: &str = "FFGUI_PROTOCOL_VERSION";
pub const ERR_PROTOCOL_JSON: &str = "FFGUI_PROTOCOL_JSON";
pub const ERR_PROTOCOL_ID: &str = "FFGUI_PROTOCOL_ID";
pub const ERR_PROTOCOL_METHOD: &str = "FFGUI_PROTOCOL_METHOD";
pub const ERR_PROTOCOL_PARAMS: &str = "FFGUI_PROTOCOL_PARAMS";
pub const ERR_SOURCE_KIND: &str = "FFGUI_SOURCE_KIND";
pub const ERR_SOURCE_PATH: &str = "FFGUI_SOURCE_PATH";
pub const ERR_SOURCE_NOT_FOUND: &str = "FFGUI_SOURCE_NOT_FOUND";
pub const ERR_OUTPUT_PATH: &str = "FFGUI_OUTPUT_PATH";
pub const ERR_OUTPUT_EXISTS: &str = "FFGUI_OUTPUT_EXISTS";
pub const ERR_PARTIAL_EXISTS: &str = "FFGUI_PARTIAL_EXISTS";
pub const ERR_TRACK_IDS: &str = "FFGUI_TRACK_IDS";
pub const ERR_TITLE_UNKNOWN: &str = "FFGUI_TITLE_UNKNOWN";
pub const ERR_TITLE_MISMATCH: &str = "FFGUI_TITLE_MISMATCH";
pub const ERR_UNSUPPORTED: &str = "FFGUI_UNSUPPORTED";
pub const ERR_KEYDB: &str = "FFGUI_KEYDB";
pub const ERR_CANCELLED: &str = "FFGUI_CANCELLED";
pub const ERR_INTERNAL: &str = "FFGUI_INTERNAL";

pub fn params(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}
