# 项目协作规则

- 沟通：Studio-PM 是唯一与用户沟通的入口。所有 bot 之间的沟通在 `deepseek-studio` 群聊中进行，禁止 bot 私聊用户或私聊 PM 外其他 bot。
- 派单：PM 在群聊中 @ 对应 bot 派单，一轮尽量只派一个席位，一张卡写全后续步骤，减少 bot 互呼次数。
- 提交：提交前必须跑全量 gate（`npm run gate`），但全量 gate 由 PM 统一执行；其他 bot 在等待期间不要并行跑全量 gate / `npm test`，避免 OOM。中间态允许红，但每次改完需自行跑 `npx tsc --noEmit` 确认无红色。
- 开发规范：遵循 `E:\NAS\开发规范.md` 及 `docs/` 下文档。
- 路线：多窗口 bot 聊天室及多窗口开发冻结，不再继续；单窗口 agent 核心继续推进。
