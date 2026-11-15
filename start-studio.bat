@echo off
rem start-studio.bat -- dev-tree launcher (2026-11-15: removed hard-coded drive path and env overrides)
rem Workspace root and policy mode now come from config root (dev: workspaceRoot=E:\NAS, policyMode=full).
rem To change mode/workspace temporarily, edit config.json -- env vars no longer pin it silently.
cd /d "%~dp0"
npm run tauri:dev > tauri-real.log 2>&1
