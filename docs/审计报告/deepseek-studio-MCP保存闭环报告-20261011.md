# deepseek-studio MCP 保存问题闭环报告

- 日期：2026-10-11
- 症状：MCP 服务器配置「保存不了」——UI 提示成功，重启后配置消失
- 结论：**已闭环**。读写 schema 已统一到嵌套式，round-trip 验证通过

---

## 1. 根因（回顾）

`mcp-servers.json` 的**写路径与读路径用了不同 schema**（假成功的一种）：

| 侧 | 旧行为 | 后果 |
|----|--------|------|
| 写 saveServer | `all[serverId] = config` 写到**顶层** | 写入成功，返回 ok:true |
| 读 loadMcpServers | 只读 `parsed.servers` | 顶层条目一律被丢弃 |

用户点保存 → 写顶层 → ok:true → UI 显示「已保存」；
但宿主重启后 loadMcpServers 只读 `.servers` → 条目消失，表现为「存不上」。
历史文件因 `ensureMcpConfig`（嵌套）与 `saveServer`（平铺）并存，同时含两套 schema：
`{ servers: { example-filesystem: {...} }, TVPIlot: {...}, TVPilot: {...} }`

---

## 2. 修复（当前代码）

### 写侧 saveServer（mcp-controller.ts:535-560）
```ts
let file: { servers: Record<string, McpServerConfig> } = { servers: {} };
// 读旧文件；优先取 .servers，否则把非 servers 顶层键迁移进来
try {
  const parsed = JSON.parse(fs.readFileSync(configPath, ''utf8''));
  if (parsed && typeof parsed === ''object'') {
    if (parsed.servers && typeof parsed.servers === ''object'') {
      file.servers = parsed.servers;
    } else {
      for (const [k, v] of Object.entries(parsed)) {
        if (k !== ''servers'' && v && typeof v === ''object'') file.servers[k] = v;
      }
    }
  }
} catch { /* 新文件 */ }
file.servers[serverId] = config;                    // ← 统一写嵌套
fs.writeFileSync(configPath, JSON.stringify(file, null, 2), ''utf8'');
this.servers = file.servers;                        // ← 内存也取 .servers
```

### 读侧 loadMcpServers（mcp-controller.ts:69-91）
```ts
if (parsed.servers && typeof parsed.servers === ''object'') {
  return parsed.servers as Record<string, McpServerConfig>;   // 标准嵌套式
}
// 兼容历史平铺式：顶层键（除 servers 外）当作服务器
const out = {};
for (const [k, v] of Object.entries(parsed)) {
  if (k !== ''servers'' && v && typeof v === ''object'') out[k] = v;
}
return out;
```

写侧统一写 `.servers`，读侧优先读 `.servers`、并兼容历史平铺——**两侧 schema 已对齐**。

---

## 3. Round-trip 验证（决定性证据）

磁盘文件 `C:\Users\lidicn\.config\deepseek-studio\mcp-servers.json`（709 字节，最后写入 2026-10-11 19:49:01）：
```json
{
  "servers": {
    "example-filesystem": { ... },
    "TVPIlot": { ... "transport": "http", "url": "http://192.168.2.200:8090/mcp" },
    "TVPilot": { ... "transport": "http", "url": "http://192.168.2.200:8090/mcp" },
    "ws-test-save": { ... "url": "http://127.0.0.1:9999/wstest" }
  }
}
```

**证据链**：
1. 历史混杂条目（TVPIlot / TVPilot 原在顶层）现已被迁移进 `.servers` —— 写侧迁移逻辑生效
2. 新保存的 `ws-test-save` 落在 `.servers` 内 —— 写路径正确
3. 读侧 `loadMcpServers` 读 `parsed.servers` → 会返回全部 4 条 —— 与写入一致

→ **写路径 == 读路径，round-trip 成立。重启后配置可读回，本次为真成功。**

---

## 4. 残留项（不阻塞，建议清理）

| 项 | 说明 |
|----|------|
| 重复条目 | `TVPIlot` 与 `TVPilot` 是同一 URL 的两条记录（大小写不同），建议删除其一 |
| headers 未落盘 | `ws-test-save` 无 `headers` 字段；`mcp.save` 的 execute 是否透传 `headers` 值得确认（历史文件里 headers 均为 `{}`，暂未影响） |

---

## 5. 方法论沉淀

1. **「保存不了」的首查动作是读写往返（round-trip）**：写一次、读一次、比对。不要只读写函数或只读读函数——本例两侧单独看都「正确」，错在 schema 不匹配。
2. **最硬的证据是磁盘文件本身**：文件里同时存在 `servers:{...}` 与顶层 `TVPilot:{}`，一眼坐实 schema 混杂。
3. **`ok:true` ≠ 持久化成功**：`saveServer` 的 ok 只表示 `writeFileSync` 没抛异常，不保证能被自己的读路径解析。与「成功必须携带可判定证据」「假成功比报错更贵」同源。
4. **修复后仍要重做 round-trip**：本次收尾再次读磁盘，确认 `.servers` 已统一、新条目落位正确，才算闭环——而非凭「用户说成功了」就宣布结束。
