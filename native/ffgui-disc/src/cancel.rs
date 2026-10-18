//! 取消登记：主线程读 stdin 的 cancel 请求置位，worker 线程里的 Sink::should_cancel
//! 与 libfreemkv::Halt 都读同一标志。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

fn registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(id.to_string(), flag.clone());
    flag
}

/// 已登记的 id 对应的取消标志；未登记返回一个新标志（任务还没登记时的取消读不到它，
/// 但主循环一定先 register 再跑 job，因此正常路径都会命中）。
pub fn flag_for(id: &str) -> Arc<AtomicBool> {
    lookup(id).unwrap_or_else(|| Arc::new(AtomicBool::new(false)))
}

pub fn lookup(id: &str) -> Option<Arc<AtomicBool>> {
    let guard = registry().lock().unwrap_or_else(|e| e.into_inner());
    guard.get(id).cloned()
}

pub fn cancel(id: &str) -> bool {
    match lookup(id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

pub fn is_cancelled(id: &str) -> bool {
    lookup(id).is_some_and(|f| f.load(Ordering::SeqCst))
}
