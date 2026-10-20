//! 导出模块内部工具：临时目录、文件名、file:// URL、PDF 页数解析、TTL 清理。

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// `%TEMP%\MarpWorkbench\`：所有导出临时文件根目录（契约 §1.6 / 计划 §3.6）
pub fn temp_root() -> PathBuf {
    std::env::temp_dir().join("MarpWorkbench")
}

/// 创建一个唯一临时目录（已创建），失败返回 io::Error
pub fn new_dir(prefix: &str) -> std::io::Result<PathBuf> {
    let root = temp_root();
    fs::create_dir_all(&root)?;
    for _ in 0..8 {
        let dir = root.join(format!("{prefix}-{}", random_hex(8)));
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "无法创建临时目录",
    ))
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    {
        use rand::RngCore;
        rand::thread_rng().fill_bytes(&mut buf);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 文件名时间戳（本地时区）：`20261020-140530`
pub fn timestamp_slug() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 由 deck 标题生成安全文件名主干（保留中文，去掉非法字符；空则用 fallback）
pub fn safe_stem(title: Option<&str>, fallback: &str) -> String {
    let raw = title.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fallback);
    let cleaned = crate::util::sanitize_filename(raw);
    // 去掉扩展名（标题可能自带 .md）
    let stem = crate::util::file_stem(&cleaned);
    let stem = stem.trim().trim_end_matches('.').to_string();
    if stem.is_empty() {
        fallback.to_string()
    } else {
        stem
    }
}

/// 在目录内生成不冲突的文件名：`<stem>-<ts>.<ext>`，重名追加 `-1`。
pub fn unique_file_name(dir: &Path, stem: &str, ext: &str) -> String {
    let base = format!("{stem}-{}", timestamp_slug());
    let mut candidate = format!("{base}.{ext}");
    let mut n = 1;
    while dir.join(&candidate).exists() {
        candidate = format!("{base}-{n}.{ext}");
        n += 1;
        if n > 999 {
            break;
        }
    }
    candidate
}

/// Windows 本地绝对路径 → `file:///C:/...`（非 ASCII 片段 percent-encode）
pub fn file_url(path: &Path) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut s = abs.to_string_lossy().to_string();
    if s.starts_with("\\\\?\\") {
        s = s.trim_start_matches("\\\\?\\").to_string();
    }
    let s = s.replace('\\', "/");
    // 这个字符集与 Node 的 pathToFileURL 对齐：保留 / : . - _ ~
    const KEEP: &percent_encoding::AsciiSet = &NON_ALPHANUMERIC
        .remove(b'/')
        .remove(b':')
        .remove(b'.')
        .remove(b'-')
        .remove(b'_')
        .remove(b'~');
    let encoded = utf8_percent_encode(&s, KEEP).to_string();
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

/// 从 PDF 字节估算页数：统计 `/Type /Page`（排除 `/Pages`）。
/// Chrome/Edge 打印出的 PDF 页对象字典未压缩，属于可靠的轻量解析（实测与 pdfjs 一致）。
pub fn count_pdf_pages(bytes: &[u8]) -> usize {
    let needle = b"/Page";
    let mut count = 0usize;
    let mut i = 0usize;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            // 后面紧跟 's' 的是 /Pages
            let after = bytes.get(i + needle.len()).copied().unwrap_or(0);
            let is_pages = after == b's';
            // 前面必须是 /Type + 空白
            if !is_pages && preceded_by_type(bytes, i) {
                count += 1;
            }
            i += needle.len();
        } else {
            i += 1;
        }
    }
    count
}

fn preceded_by_type(bytes: &[u8], page_start: usize) -> bool {
    // 向前跳过空白，要求以 b"/Type" 结尾
    let mut j = page_start;
    while j > 0 && matches!(bytes[j - 1], b' ' | b'\r' | b'\n' | b'\t') {
        j -= 1;
    }
    if j < 5 {
        return false;
    }
    &bytes[j - 5..j] == b"/Type"
}

/// 清理临时根目录下超过 `max_age` 的条目（目录/文件），忽略错误。
pub fn cleanup_older_than(root: &Path, max_age: Duration) {
    let Ok(entries) = fs::read_dir(root) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .or_else(|_| fs::metadata(&path).and_then(|m| m.modified()));
        let Ok(modified) = modified else { continue };
        let Ok(age) = now.duration_since(modified) else { continue };
        if age > max_age {
            if path.is_dir() {
                let _ = fs::remove_dir_all(&path);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// 清理一次导出的临时目录（失败/取消路径也必须调用）。
/// Windows 下浏览器刚被 kill 时文件句柄可能短暂未释放 → 重试删除，避免残留 profile。
pub fn cleanup_dir(dir: &Path) {
    for attempt in 0..5 {
        match fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt < 4 => std::thread::sleep(Duration::from_millis(120)),
            Err(_) => return,
        }
    }
}

/// 清理临时根目录下指定前缀且超过 `max_age` 的目录（profile/失败残留兜底）。
/// 例：`cleanup_stale_dirs(&root, &["cdp-profile-", "chrome-profile-", "pdf-"], 1h)`
pub fn cleanup_stale_dirs(root: &Path, prefixes: &[&str], max_age: Duration) {
    let Ok(entries) = fs::read_dir(root) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !prefixes.iter().any(|p| name.starts_with(p)) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let Ok(age) = now.duration_since(modified) else { continue };
        if age > max_age {
            if meta.is_dir() {
                cleanup_dir(&entry.path());
            } else {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// 读取文件头判断是否为 PDF（防浏览器写出错误内容）
pub fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_page_count_parses_chrome_pdf() {
        // 最小化模拟：两个页对象 + 一个 Pages 节点
        let fake = b"%PDF-1.7\n1 0 obj\n<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>\nendobj\n\
            2 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n\
            3 0 obj\n<< /Type/Page /Parent 1 0 R >>\nendobj\n%%EOF";
        assert_eq!(count_pdf_pages(fake), 2);
    }

    #[test]
    fn safe_stem_strips_extension_and_illegal() {
        assert_eq!(safe_stem(Some("我的 演示.md"), "demo"), "我的 演示");
        // sanitize_filename 只保留 basename（防路径穿越），所以 "a/b:c*?" → "c__"
        assert_eq!(safe_stem(Some("a/b:c*?"), "demo"), "c__");
        assert_eq!(safe_stem(Some("   "), "demo"), "demo");
        assert_eq!(safe_stem(None, "demo"), "demo");
    }

    #[test]
    fn file_url_is_encoded() {
        let url = file_url(Path::new(r"C:\Users\a b\中文\print.html"));
        assert!(url.starts_with("file:///C:/"));
        assert!(url.contains("%20"));
        assert!(!url.contains('\\'));
    }
}
