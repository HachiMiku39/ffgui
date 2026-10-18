//! ffgui-disc 的库目标：二进制（`src/main.rs`）与集成测试共用协议/模型/任务模块。
//! 进程入口只在 `main.rs`，这里不重复实现任何逻辑。

pub mod cancel;
pub mod errors;
pub mod jobs;
pub mod model;
pub mod protocol;
pub mod sink;
pub mod source;
