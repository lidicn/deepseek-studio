# 组件 props 详表（visual-report）

渲染器只接受 **4 种已注册组件**：`Text` / `Image` / `Column` / `Row`。
未注册的 type 会降级为可读标题占位（该子树的 children 被丢弃），卡片其余部分照常渲染。

## 通用约束

| 约束 | 值 | 超限行为 |
|---|---|---|
| `v` | 必须为 `1` | 整块不渲染，原样保留代码块 |
| 深度 `depth` | ≤ 8 | 该节点被裁剪（`max_depth`） |
| 单节点 children 数 | ≤ 24 | 超出部分被裁剪（`max_children`） |
| 整棵树的节点总数 | ≤ 120 | 超出部分被裁剪（`max_nodes`） |
| 单个 `Text.text` 长度 | ≤ 400 | 截断并加 `…`（不切开 emoji） |
| 文本/属性转义 | `& < > " '` | 全部走 `escapeHtml`，无例外 |

**未列出的字段一律被忽略**：`html` / `script` / `style` / `on*` 之类既不生效也不报错（写了等于没写）。

---

## Text

纯文本节点，行内文字。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `"Text"` | 是 | 组件类型名 |
| `text` | `string` | 是 | 文案内容；非字符串（数字/布尔会被转成字符串，对象/数组/函数 → 空串） |
| `variant` | `"title" \| "subtitle" \| "body" \| "meta"` | 否 | 缺省为 `body` |

`variant` 的语义约定：

| variant | 用途 | 视觉 |
|---|---|---|
| `title` | 卡片主标题 / 分组标题 | 最大字号、加粗 |
| `subtitle` | 条目标题 / 小节副标题 | 中字号、加粗 |
| `body` | 正文说明 | 常规字号 |
| `meta` | 来源、时间、备注等弱信息 | 小字号、次要色 |

**不允许 children**（即使写了 `children` 也会被丢弃）。

```json
{ "type": "Text", "text": "星际穿越", "variant": "subtitle" }
```

---

## Image

图片节点。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `"Image"` | 是 | 组件类型名 |
| `src` | `string \| null` | 是（可为 `null`） | 图片地址；**仅 `http://` / `https://` 会被放行** |
| `alt` | `string` | 是 | 无图占位时显示的文字（也会作为 `aria-label`） |
| `ratio` | `"2/3" \| "16/9"` | 否 | 缺省为自适应 |
| `fallback` | `{ hue?: number }` | 否 | 占位渐变色相，`0–360` 整数，非有限数回落 `210` |

`src` 的三种结果：

| 情况 | 渲染 | 状态 |
|---|---|---|
| `http(s)://` 合法地址 | `<img loading="lazy" decoding="async" referrerpolicy="no-referrer">` | 正常 |
| `null` | 渐变占位块（按 `fallback.hue`） | **设计内状态，不算降级** |
| 其它协议（`javascript:` / `data:` / `ftp:` 等） | 渐变占位块 | 降级（`image_unsafe_src`） |

> `referrerpolicy="no-referrer"` 是刻意选择：不少图床按 Referer 判防盗链，不带 Referer 反而更容易加载。

**不允许 children**。

```json
{
  "type": "Image",
  "src": null,
  "alt": "星际穿越 海报",
  "ratio": "2/3",
  "fallback": { "hue": 210 }
}
```

---

## Column

竖向容器。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `"Column"` | 是 | 组件类型名 |
| `children` | `Node[]` | 否 | 子节点数组，≤ 24 个；缺省视为空数组 |

**不允许除 `children` 之外的任何 props**（其它字段会被忽略）。

```json
{ "type": "Column", "children": [ /* ... */ ] }
```

---

## Row

横向容器，典型用法是「左图右文」。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `"Row"` | 是 | 组件类型名 |
| `children` | `Node[]` | 否 | 子节点数组，≤ 24 个 |

**不允许除 `children` 之外的任何 props**。

```json
{ "type": "Row", "children": [ /* ... */ ] }
```

---

## 节点类型速查

```ts
type Node =
  | { type: 'Text';   text: string; variant?: 'title'|'subtitle'|'body'|'meta' }
  | { type: 'Image';  src: string | null; alt: string; ratio?: '2/3'|'16/9'; fallback?: { hue?: number } }
  | { type: 'Column'; children?: Node[] }
  | { type: 'Row';    children?: Node[] };

interface Document { v: 1; root: Node }
```

## 渲染结果状态

渲染器对外返回三级状态：

| 状态 | 含义 | 注入层行为 |
|---|---|---|
| `ok` | 完全正常 | 展示卡片，代码块隐藏 |
| `degraded` | 部分降级（未知 type、裁剪、协议被拒） | 仍然展示卡片 |
| `failed` | 整体不合法（`v` 不为 1 / JSON 语法错） | 不渲染卡片，**原样保留代码块** |

> 语义要点：`src: null`（模型没给图）属于设计内状态，不计入 `degraded`；只有协议被拒才算降级。