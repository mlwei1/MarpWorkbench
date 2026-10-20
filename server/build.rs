// 构建期探测：web/dist 与 themes/ 是否存在，决定 rust-embed 嵌入真实产物还是占位目录。
// 说明：M1 骨架阶段 web/ 可能尚未构建；此时 exe 仍然可编译运行（返回占位页）。
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let web = Path::new("../web/dist");
    if web.is_dir() {
        println!("cargo:rustc-cfg=mwb_embed_web");
    }
    println!("cargo:rerun-if-changed=../web/dist");

    let themes = Path::new("../themes");
    if themes.is_dir() {
        println!("cargo:rustc-cfg=mwb_embed_themes");
    }
    println!("cargo:rerun-if-changed=../themes");

    println!("cargo:rustc-check-cfg=cfg(mwb_embed_web)");
    println!("cargo:rustc-check-cfg=cfg(mwb_embed_themes)");
}
