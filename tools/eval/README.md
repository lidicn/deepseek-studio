# tools/eval — Golden Contract Eval

零依赖（仅用 `tsx` 跑）、读 `fixtures/*.json`、逐条对照 src/ 真实导出函数做 PASS/FAIL。
任一 FAIL → `process.exit(1)`。

## 运行

```bash
npm run eval:golden
```

## 文件布局

```
tools/eval/
├── run.ts              # 执行器（读 fixtures → dispatch → deepEqual → exit code）
├── README.md           # 本文件
└── fixtures/
    ├── 01-*.json … 18-*.json   # 一条 JSON = 一条 golden 用例
```

## fixture 格式

每条 fixture 是一个 JSON 文件：

```jsonc
{
  "name": "人类可读的用例描述",
  "contract": "tool-contract | tool-result-format | continuation-prompt | policy",
  "case": "run.ts 里 switch 用的 case 名",
  "input": { /* 传给被测函数的参数 */ },
  "expect": /* 期望返回值；deepEqual 比对 */
}
```

## 如何加一条新用例

1. 在 `fixtures/` 下新建一个 `.json`，编号续上（如 `19-xxx.json`）。
2. 选 `contract` 和 `case`。当前支持的 case 一览：

   | contract | case | input 字段 | expect |
   |---|---|---|---|
   | tool-contract | `map` | `invocationName`, `params` | `{id, params}` 或 `null` |
   | tool-contract | `isSupported` | `invocationName` | boolean |
   | tool-contract | `isFileTool` | `tool` | boolean |
   | tool-contract | `detectRisks` | `command` | string[] |
   | tool-result-format | `formatToolResultText` | `result` | string |
   | tool-result-format | `textContent` | `text` | array |
   | tool-result-format | `buildExecExtras` | `input` (object) | object |
   | tool-result-format | `buildErrorExtras` | `input` (object) | object |
   | tool-result-format | `shouldSkipAutoContinue` | `results` | boolean |
   | tool-result-format | `joinContent` | `content` | string \| null |
   | continuation-prompt | `extractTaskCompleteSignal` | `text` | object \| null |
   | continuation-prompt | `buildContinuationPrompt` | `originalTask`, `executions`, `toolCatalog?`, `mode:"sentinel"` | `{contains:[...], notContains:[...]}` |
   | continuation-prompt | `clampText` | `value`, `maxLen` | string \| undefined |
   | continuation-prompt | `shouldNudge` | `visibleText` | boolean |
   | policy | `evaluate` | `tool`, `params`, `mode`, `workspaceRoot?`, `trustedDirs?` | `{decision, reason}`（部分匹配） |

3. 跑 `npm run eval:golden` 确认新用例 PASS。

## 注意

- `policy/evaluate` 的 workspace 用纯词法 deps 注入（不碰真实文件系统），
  fixture 里的路径写 `/workspace/...` 即可，跨平台自动 resolve。
- expect 对 policy 是**部分匹配**：只比对你在 expect 里写出的字段（通常只写 decision + reason），
  不校 riskFlags / detail，避免脆弱。
- 不要在 fixture 里写任何 src/ 下的路径依赖——这里只测纯函数契约。
