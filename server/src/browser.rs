use std::path::PathBuf;

use serde::Serialize;

/// 本机可用浏览器（导出 PDF / 截图用）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub chrome: Option<String>,
    pub edge: Option<String>,
    pub usable: bool,
    pub preferred: Option<String>,
}

/// 检测本机 Chrome / Edge。顺序：标准安装路径 → 注册表 App Paths。
/// 返回路径均为可执行文件绝对路径。导出模块可复用本函数。
pub fn detect() -> BrowserInfo {
    let chrome = find_browser(&chrome_candidates(), "chrome.exe");
    let edge = find_browser(&edge_candidates(), "msedge.exe");
    let preferred = if chrome.is_some() {
        Some("chrome".to_string())
    } else if edge.is_some() {
        Some("edge".to_string())
    } else {
        None
    };
    BrowserInfo {
        usable: preferred.is_some(),
        preferred,
        chrome,
        edge,
    }
}

fn find_browser(candidates: &[PathBuf], exe_name: &str) -> Option<String> {
    for path in candidates {
        if path.is_file() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    registry_app_path(exe_name)
}

fn chrome_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for base in [
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("LOCALAPPDATA"),
    ]
    .into_iter()
    .flatten()
    {
        v.push(
            PathBuf::from(base)
                .join("Google")
                .join("Chrome")
                .join("Application")
                .join("chrome.exe"),
        );
    }
    v
}

fn edge_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for base in [
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("ProgramFiles"),
        std::env::var_os("LOCALAPPDATA"),
    ]
    .into_iter()
    .flatten()
    {
        v.push(
            PathBuf::from(base)
                .join("Microsoft")
                .join("Edge")
                .join("Application")
                .join("msedge.exe"),
        );
    }
    v
}

/// 读取 `HKLM/HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>`
#[cfg(windows)]
fn registry_app_path(exe_name: &str) -> Option<String> {
    use std::process::Command;
    let key = format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{}",
        exe_name
    );
    for hive in ["HKLM", "HKCU"] {
        let Ok(out) = Command::new("reg")
            .args(["query", &format!("{}\\{}", hive, key), "/ve"])
            .output()
        else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            let Some(idx) = line.find("REG_SZ") else { continue };
            let value = line[idx + "REG_SZ".len()..].trim().trim_matches('"');
            if value.to_ascii_lowercase().ends_with(&exe_name.to_ascii_lowercase()) {
                let p = PathBuf::from(value);
                if p.is_file() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn registry_app_path(_exe_name: &str) -> Option<String> {
    None
}
