@echo off
cd /d E:\NAS\deepseek-studio
set STUDIO_WORKSPACE_ROOT=E:\NAS\deepseek-studio
set STUDIO_POLICY_MODE=full
npm run tauri:dev > tauri-real.log 2>&1
