use std::path::PathBuf;

use rust_embed::RustEmbed;

// 构建期由 build.rs 决定：web/dist 存在 → 内嵌真实前端产物；否则内嵌占位页（骨架期可编译运行）
#[cfg(mwb_embed_web)]
#[derive(RustEmbed)]
#[folder = "../web/dist/"]
struct WebAssets;
#[cfg(not(mwb_embed_web))]
#[derive(RustEmbed)]
#[folder = "assets/placeholder/"]
struct WebAssets;

// 内置主题：themes/*.css（构建期内嵌）；不存在时嵌入空占位目录
#[cfg(mwb_embed_themes)]
#[derive(RustEmbed)]
#[folder = "../themes/"]
struct ThemeAssets;
#[cfg(not(mwb_embed_themes))]
#[derive(RustEmbed)]
#[folder = "assets/empty/"]
struct ThemeAssets;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn web_disk_dir() -> PathBuf {
    std::env::var_os("MWB_WEB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir().join("../web/dist"))
}

pub fn themes_disk_dir() -> PathBuf {
    std::env::var_os("MWB_THEMES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir().join("../themes"))
}

/// 开发期（debug）从磁盘读 web 资源，可被 MWB_WEB_DIR 覆盖；release 默认用内嵌资源
fn web_disk_enabled() -> bool {
    cfg!(debug_assertions) || std::env::var_os("MWB_WEB_DIR").is_some()
}

fn themes_disk_enabled() -> bool {
    cfg!(debug_assertions) || std::env::var_os("MWB_THEMES_DIR").is_some()
}

/// 读取内嵌/磁盘前端资源，返回 (bytes, 扩展名)
pub fn read_web(rel: &str) -> Option<(Vec<u8>, String)> {
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return read_web("index.html");
    }
    let ext = crate::util::ext_of(rel);
    if web_disk_enabled() {
        let dir = web_disk_dir();
        if dir.is_dir() {
            if let Some(safe) = crate::util::safe_relative_path(rel) {
                if let Ok(bytes) = std::fs::read(dir.join(safe)) {
                    return Some((bytes, ext));
                }
            }
        }
    }
    WebAssets::get(rel).map(|f| (f.data.into_owned(), ext))
}

pub fn read_web_index() -> Option<Vec<u8>> {
    read_web("index.html").map(|(bytes, _)| bytes)
}

/// 内置主题文件名列表（只含 *.css）
pub fn builtin_theme_files() -> Vec<String> {
    if themes_disk_enabled() {
        let dir = themes_disk_dir();
        if dir.is_dir() {
            let mut files: Vec<String> = std::fs::read_dir(dir)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .filter_map(|e| {
                            let name = e.file_name().to_string_lossy().to_string();
                            if name.to_ascii_lowercase().ends_with(".css") {
                                Some(name)
                            } else {
                                None
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            files.sort();
            if !files.is_empty() {
                return files;
            }
        }
    }
    let mut files: Vec<String> = ThemeAssets::iter()
        .map(|f| f.to_string())
        .filter(|f| f.to_ascii_lowercase().ends_with(".css"))
        .collect();
    files.sort();
    files
}

/// 读取内置主题 CSS（按文件名）
pub fn builtin_theme_css(filename: &str) -> Option<String> {
    if themes_disk_enabled() {
        let dir = themes_disk_dir();
        if let Some(safe) = crate::util::safe_relative_path(filename) {
            if let Ok(text) = std::fs::read_to_string(dir.join(safe)) {
                return Some(text);
            }
        }
    }
    ThemeAssets::get(filename).map(|f| String::from_utf8_lossy(&f.data).to_string())
}
