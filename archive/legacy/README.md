# Legacy Archive

This directory contains code that is kept for history and manual recovery but is
not part of the active build, test, or runtime surface.

## Archived on 2026-10-21

- `lever-hub/`
  - Former in-process HTTP service on port 8762.
  - Used to wrap the external `E:/NAS/Lever-Hub` Python toolchain.
  - The Studio settings "投喂" tab and the `src/api/main.ts` startup hook were
    removed when this directory was archived.

- `yuanbao-audit/`
  - Former standalone Yuanbao audit application and injection project.
  - The Studio right-sidebar integration used `http://127.0.0.1:8761`.
  - This is external integration history only. The active tool-execution audit
    ring (`src/host/audit.ts`) and the multi-bot audit meeting
    (`src/host/bot/audit-meeting.ts`) are intentionally retained.

## Restore Policy

Restoring code from this directory requires an explicit product decision and a
new implementation plan. Do not re-add imports or startup hooks directly from
this archive into `src/`.
