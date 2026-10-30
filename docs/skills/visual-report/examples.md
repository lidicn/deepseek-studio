# 完整示例（visual-report）

每个示例都包含：**Markdown 正文** + **一个 `vis-json` 代码块**。正文不能省。

---

## 1. 榜单 / 推荐（左图右文）

正文：

> 2026 年科幻片口碑 Top 3，评分来自 2026-10 主流评分平台（样本量均超 20 万），已剔除样本不足的条目。

```vis-json
{
  "v": 1,
  "root": {
    "type": "Column",
    "children": [
      { "type": "Text", "text": "2026 科幻片 Top 3", "variant": "title" },
      {
        "type": "Row",
        "children": [
          { "type": "Image", "src": null, "alt": "星际穿越 海报", "ratio": "2/3", "fallback": { "hue": 210 } },
          {
            "type": "Column",
            "children": [
              { "type": "Text", "text": "星际穿越", "variant": "subtitle" },
              { "type": "Text", "text": "诺兰在引力与时间之间搭了一座桥，票房与口碑双高。" },
              { "type": "Text", "text": "来源：2026-10 票房榜", "variant": "meta" }
            ]
          }
        ]
      },
      {
        "type": "Row",
        "children": [
          { "type": "Image", "src": null, "alt": "沙丘 海报", "ratio": "2/3", "fallback": { "hue": 30 } },
          {
            "type": "Column",
            "children": [
              { "type": "Text", "text": "沙丘", "variant": "subtitle" },
              { "type": "Text", "text": "维伦纽瓦的视觉工业化，把生态史诗推到了新高度。" },
              { "type": "Text", "text": "来源：2026-10 票房榜", "variant": "meta" }
            ]
          }
        ]
      }
    ]
  }
}
```

---

## 2. 参数横评（纯文本，无图）

正文：

> 三款主流 NAS 的关键参数对比，容量按官方标称，噪音为满载 20 分钟平均值。

```vis-json
{
  "v": 1,
  "root": {
    "type": "Column",
    "children": [
      { "type": "Text", "text": "NAS 关键参数对比", "variant": "title" },
      {
        "type": "Row",
        "children": [
          { "type": "Text", "text": "型号 A", "variant": "subtitle" },
          { "type": "Text", "text": "8 盘位 / 四核 / 32GB / 待机 18W" },
          { "type": "Text", "text": "噪音 32dB", "variant": "meta" }
        ]
      },
      {
        "type": "Row",
        "children": [
          { "type": "Text", "text": "型号 B", "variant": "subtitle" },
          { "type": "Text", "text": "6 盘位 / 四核 / 16GB / 待机 14W" },
          { "type": "Text", "text": "噪音 29dB", "variant": "meta" }
        ]
      },
      {
        "type": "Row",
        "children": [
          { "type": "Text", "text": "型号 C", "variant": "subtitle" },
          { "type": "Text", "text": "4 盘位 / 处理器 / 8GB / 待机 11W" },
          { "type": "Text", "text": "噪音 27dB", "variant": "meta" }
        ]
      }
    ]
  }
}
```

---

## 3. 时间线 / 脉络（纯 Column 嵌套）

正文：

> 项目从立项到 GA 的三个阶段，关键节点与产出如下。

```vis-json
{
  "v": 1,
  "root": {
    "type": "Column",
    "children": [
      { "type": "Text", "text": "项目时间线", "variant": "title" },
      {
        "type": "Column",
        "children": [
          { "type": "Text", "text": "2025-12 立项", "variant": "subtitle" },
          { "type": "Text", "text": "完成需求澄清与技术选型，输出架构方案 v1。" }
        ]
      },
      {
        "type": "Column",
        "children": [
          { "type": "Text", "text": "2026-04 内测", "variant": "subtitle" },
          { "type": "Text", "text": "核心链路跑通，覆盖 12 个真实用例。" }
        ]
      },
      {
        "type": "Column",
        "children": [
          { "type": "Text", "text": "2026-10 GA", "variant": "subtitle" },
          { "type": "Text", "text": "发布正式版本，沉淀部署与运维手册。" }
        ]
      }
    ]
  }
}
```

---

## 4. 单物件深挖（横向 16/9 图 + 多段文本）

正文：

> 《沙丘》的改编难点在于把小说的世界观压缩到银幕可读的尺度。

```vis-json
{
  "v": 1,
  "root": {
    "type": "Column",
    "children": [
      { "type": "Image", "src": null, "alt": "沙丘 主视觉", "ratio": "16/9", "fallback": { "hue": 35 } },
      { "type": "Text", "text": "沙丘", "variant": "title" },
      { "type": "Text", "text": "改编取舍", "variant": "subtitle" },
      { "type": "Text", "text": "把多线叙事的家族支线压缩为双线对峙，用场景与声音做区分。" },
      { "type": "Text", "text": "上映 2026-10 · 导演 维伦纽瓦", "variant": "meta" }
    ]
  }
}
```

---

## 5. 反例（会被拒绝 / 降级）

### 5.1 `v` 不为 1 → 整块不渲染

```vis-json
{ "v": 2, "root": { "type": "Text", "text": "标题" } }
```

→ 原样保留为代码块（用户看到的是原始 JSON，不是卡片）。

### 5.2 未知组件 → 该子树降级为标题占位

```vis-json
{
  "v": 1,
  "root": {
    "type": "Column",
    "children": [
      { "type": "Text", "text": "正常部分", "variant": "title" },
      { "type": "Chart", "data": [1, 2, 3] }
    ]
  }
}
```

→ "正常部分"照常渲染；`Chart` 子树降级为 `[unsupported: Chart]` 文本占位。

### 5.3 编造图片链接 → 占位而非破图

```vis-json
{
  "v": 1,
  "root": {
    "type": "Image",
    "src": "https://example.com/definitely-not-real-poster.jpg",
    "alt": "海报",
    "ratio": "2/3",
    "fallback": { "hue": 200 }
  }
}
```

→ 协议合法，放行加载；若 URL 实际 404，浏览器显示破图。**所以规则要求：只有确定存在的公开 URL 才填 `src`，否则一律 `null`。**

### 5.4 危险协议 → 降级为占位

```vis-json
{
  "v": 1,
  "root": { "type": "Image", "src": "javascript:alert(1)", "alt": "x", "fallback": { "hue": 0 } }
}
```

→ 协议被拒（`image_unsafe_src`），渲染为红色系渐变占位，绝不执行脚本。