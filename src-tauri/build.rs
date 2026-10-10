// Tauri 构建脚本：编译期读取 tauri.conf.json 并生成上下文（图标 / 窗口 / 协议）。
// v0.2 仅占位，v0.7 可在此追加 KV / IPC 相关构建钩子。
fn main() {
    tauri_build::build()
}
