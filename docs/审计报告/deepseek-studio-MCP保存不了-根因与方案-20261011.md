# deepseek-studio MCP 保存不了 — 根因定位与解决方案

- 日期：2026-10-11
- 症状：MCP 设置点保存后看似成功，但重启/刷新后配置丢失，始终存不上
- 结论：**根因已钉死 —— mcp-servers.json 的写路径与读路径使用了不同的 JSON schema**

---

## 一、铁证（磁盘文件 + 运行时实测）

### 磁盘实际文件 `C:\Users\lidicn\.config\deepseek-studio\mcp-servers.json`
```json
{
  "servers": {
    "example-filesystem": { "command": "npx", "args": [...] }
  },
  "TVPIlot": { "transport": "http", "url": "http://192.168.2.200:8090/mcp" },
  "TVPilot":  { "transport": "http", "url": "http://192.168.2.200:8090/mcp" }
}
```
**同一个文件里并存两套 schema**：
- `servers: {...}`（嵌套式）—— 读路径认这种
- `TVPIlot` / `TVPilot`（平铺在顶层）—— 写路径产生这种

### 运行时实测（node -e 直接跑 loadMcpServers 的解析逻辑）
```
顶层键:                ["servers","TVPIlot","TVPilot"]
servers 内键:          ["example-filesystem"]
loadMcpServers 返回:   ["example-filesystem"]      ← 只有这一个
被丢弃的顶层条目:      ["TVPIlot","TVPilot"]      ← 用户保存的全在这
```
即：**用户保存的 MCP 服务器被读路径全部丢弃。**

---

## 二、根因（代码定位，两处不对称）

### 写路径：`McpController.saveServer`（mcp-controller.ts:515 起）
```ts
saveServer(serverId, config) {
  ...
  let all = {};
  try { all = JSON.parse(fs.readFileSync(configPath, ''utf8'')); } catch { /* 新文件 */ }
  all[serverId] = config;                    // ← 写到【顶层】
  fs.writeFileSync(configPath, JSON.stringify(all, null, 2), ''utf8'');
  this.servers = all;                        // ← 赋的是整个对象，应为 all.servers
  return { ok: true };
}
```

### 读路径：`loadMcpServers`（mcp-controller.ts:65-78）
```ts
loadMcpServers(configPath) {
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === ''object'' && parsed.servers && typeof parsed.servers === ''object'') {
    return parsed.servers as Record<string, McpServerConfig>;   // ← 只读 .servers
  }
  return {};
}
```

### 冲突
| | 读 | 写 |
|---|---|---|
| 期望结构 | `{ servers: { id: cfg } }` | `all[id] = cfg`（平铺顶层） |
| 结果 | 只认 `servers` 键 | 写在 `servers` 之外 |

`ensureMcpConfig`（:81 起）写的是**嵌套式** `{ servers: {...} }`，而 `saveServer` 写的是**平铺式**——两套约定并存，文件因此出现混合形态。

---

## 三、为什么表现成「一直解决不了」

```
用户点保存
  → saveServer 把 TVPilot 写到顶层
  → writeFileSync 成功，返回 { ok: true }
  → UI 收到 ok:true，关闭对话框，显示「已保存」      ← 假成功
  → 宿主重启 / reload()
  → loadMcpServers 只读 .servers → TVPilot 不在其中 → 列表里消失
```

**保存动作「成功」了（ok:true），但数据从未进入读路径能识别的结构**。
所以：本次会话内可能短暂可见（`this.servers = all` 让内存里带着），**一重启就没了**——正是用户说的「存不上」。

同一形态的缺陷在项目里已出现多次（无页回退返回 ok:true 无 data、chat-send 未验证即报成功、loader 先报 running）——**「ok:true 不等于事情做成了」**。

---

## 四、解决方案（两种，推荐 A）

### 方案 A（推荐）：统一为嵌套式，改 saveServer 两行
```ts
saveServer(serverId: string, config: McpServerConfig): { ok: boolean; error?: string } {
  try {
    const configPath = process.env.STUDIO_CONFIG_DIR
      ? path.join(process.env.STUDIO_CONFIG_DIR, ''mcp-servers.json'')
      : path.join(os.homedir(), ''".config"'', ''deepseek-studio'', ''mcp-servers.json'');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    let file: { servers: Record<string, McpServerConfig> } = { servers: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, ''utf8''));
      if (parsed && typeof parsed === ''object'') {
        file.servers = (parsed.servers && typeof parsed.servers === ''object'') ? parsed.servers : {};
      }
    } catch { /* 新文件 */ }

    file.servers[serverId] = config;                                  // 写进 servers
    fs.writeFileSync(configPath, JSON.stringify(file, null, 2), ''utf8'');
    this.servers = file.servers;                                      // 只赋 servers
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

### 方案 B（兼容性更强）：loadMcpServers 同时接受两种形态
```ts
export function loadMcpServers(configPath?: string): Record<string, McpServerConfig> {
  const p = configPath ?? defaultConfigPath();
  try {
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, ''utf8''));
    if (!parsed || typeof parsed !== ''object'') return {};
    if (parsed.servers && typeof parsed.servers === ''object'') return parsed.servers;
    // 兼容历史平铺式：把非 servers 顶层键当作服务器
    const out: Record<string, McpServerConfig> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k !== ''servers'' && v && typeof v === ''object'') out[k] = v as McpServerConfig;
    }
    return out;
  } catch { return {}; }
}
```

**建议 A+B 同时做**：A 修根因（写对位置），B 兜底历史数据（现有文件里的顶层 TVPilot 能被读回，无需用户重填）。

### 数据迁移（可选，一次性）
现有文件已混合形态。做 B 之后顶层条目即可被读取；也可写一段迁移把顶层键并入 `servers` 并删除顶层键。

---

## 五、附带的第二个缺陷（HTTP MCP 必需）

用户 MCP 全是 **HTTP 类型**（TVPilot: http://192.168.2.200:8090/mcp），但：

1. `mcp.save` 的 execute（desktop-host.ts）只透传 6 个字段：
```ts
controller.saveServer(serverId, {
  command, args, env, transport, url, cwd   // ← 没有 headers
});
```
2. `McpServerConfig` 接口（mcp-controller.ts:19-32）**根本没声明 `headers` 字段**。
3. `sendHttpRequest` / `testHttpConnection` 里 headers 是**硬编码**的 `Content-Type` / `Accept`，无法注入自定义鉴权头。

→ 若该 HTTP MCP 需要 `Authorization` 等自定义头，当前实现无法通过。
**修复**：`McpServerConfig` 增加 `readonly headers?: Record<string,string>`；mcp.save 透传；sendHttpRequest/testHttpConnection 合并 `config.headers`。

---

## 六、验证方法（改完怎么确认）

1. **往返测试**：调用 saveServer 保存 → 重新 `new McpController()`（模拟重启）→ `listServerIds()` 应包含刚存的 id。
2. **磁盘核对**：保存后读 `mcp-servers.json`，确认新条目在 `servers` 对象内。
3. **端到端**：UI 保存 TVPilot → 宿主重启 → `mcp.list` 返回应含 TVPilot → `mcp.test` 能连通。

---

## 七、一句话总结

> MCP 保存不了的根因：**保存写到了 JSON 顶层，读取只认 `.servers` 子对象**。
> 写成功、报成功、实际读不回——改 saveServer 写进 `servers` 即可根治。
