use std::{
    path::PathBuf,
    sync::Arc,
};

use tokio::sync::watch;

use crate::browser::BrowserInfo;

/// 全局应用状态（只读为主；需要写入时走文件系统/内部锁）
pub struct AppState {
    pub app_version: &'static str,
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub started_at: String,
    /// 数据目录 = 工作区根目录（默认 文档\MarpWorkbench，可用 MWB_DATA_DIR 覆盖）
    pub data_dir: PathBuf,
    pub shutdown_tx: watch::Sender<bool>,
    pub browser: BrowserInfo,
}

impl AppState {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }

    pub fn url_with_token(&self) -> String {
        format!("http://127.0.0.1:{}/?token={}", self.port, self.token)
    }

    pub fn deck_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join(id)
    }

    pub fn deck_slides_path(&self, id: &str) -> PathBuf {
        self.deck_dir(id).join("slides.md")
    }

    pub fn deck_assets_dir(&self, id: &str) -> PathBuf {
        self.deck_dir(id).join("assets")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn recent_path(&self) -> PathBuf {
        self.data_dir.join("recent.json")
    }

    pub fn user_themes_dir(&self) -> PathBuf {
        self.data_dir.join("themes")
    }

    pub fn exports_dir(&self) -> PathBuf {
        self.data_dir.join("exports")
    }

    pub fn trash_dir(&self) -> PathBuf {
        self.data_dir.join(".trash")
    }

    pub fn instance_path(&self) -> PathBuf {
        self.data_dir.join("instance.json")
    }
}

pub type SharedState = Arc<AppState>;

/// 生成 32 字节随机 token（64 hex 字符）
pub fn gen_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
