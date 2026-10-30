---
name: visual-report
description: 当回答天然是「多条目 / 多维度 / 图文并茂」（榜单、推荐、对比、时间线、图集、数据概览）时，在 Markdown 正文之后追加一个 vis-json 代码块，Studio 会渲染成可视化卡片。单条事实、纯解释、代码问答不要使用。
---

# 可视化报告 Skill

## 何时使用

仅当结果**天然是多条目 / 多维度**时使用。

| 用户意图 | 组件组合 |
|---|---|
| 推荐 / 榜单 / 搜索结果 | Column[ Text(title), Row[Image, Column[Text(title), Text(body)]], … ] |
| 对比两个以上对象 | Column[ Text(subtitle), Row[Image, Text(body)] × N, Text(meta) ] |
| 过程 / 历史 / 脉络 | Column[ Text(title), Column[Text(subtitle), Text(body)] × N ] |
| 单物件深挖（一部电影、一个项目） | Column[ Image, Text(title), Text(subtitle), Text(body), Text(meta) ] |
| 参数横评 | Column[ Text(title), Row[Text(meta), Text(body)] × N ] |

## 何时不要使用

- 单条事实、定义解释、代码问答、情感陪伴
- 结果条目少于 3 条
- 用户明确要求简洁 / 只要一句话

## 硬性规则

1. **先写 Markdown 正文**（100–400 字，先给结论与数据来源），再追加**一个** vis-json 代码块。正文是保底层，不能省。
2. `v` 必须为 `1`。深度 ≤ 8，单节点子元素 ≤ 24，总节点 ≤ 120。
3. `Image.src`：**只有确定 URL 真实存在且可公开访问时才填**，否则一律 `null`。**编造图片链接是最严重错误**，会导致满屏破图。
4. `Image.src` 为 `null` 时必须给 `fallback.hue`（0–360 整数），渲染器生成同色系渐变占位。
5. 图片只允许 `http://` / `https://`；其它协议一律会被拒绝并降级为占位。
6. 文案极简：单个 `Text.text` ≤ 400 字，整卡正文建议 ≤ 140 字。**可视化是索引，不是全文**。
7. 禁止出现 `html` / `script` / `style` / `on*` 字段 —— 渲染层只接受下列 4 种 type。
8. 只能使用已注册组件：`Text` / `Image` / `Column` / `Row`。禁止自创 type（未注册会降级为可读标题占位）。
9. 不确定就给 `Text`，不要为「显得好看」编图片。

## 输出格式

正文：给出结论 + 数据来源与时间。

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
          {
            "type": "Image",
            "src": null,
            "alt": "星际穿越 海报",
            "ratio": "2/3",
            "fallback": { "hue": 210 }
          },
          {
            "type": "Column",
            "children": [
              { "type": "Text", "text": "星际穿越", "variant": "subtitle" },
              { "type": "Text", "text": "诺兰在引力与时间之间搭了一座桥，票房与口碑双高。" },
              { "type": "Text", "text": "来源：2026-10 票房榜", "variant": "meta" }
            ]
          }
        ]
      }
    ]
  }
}
```

## 失败会怎样（让你知道规则为什么硬）

- `v` 不等于 1 → **整块不渲染**，原样保留代码块（不会出现"渲染了一半的错卡"）。
- 未知 type → 该子树降级为可读标题占位，其余部分照常渲染。
- 超出深度 / 节点上限 → 对应部分被裁剪。
- JSON 语法错 → 原样保留代码块。

组件 props 详表见 `components.md`；更多完整示例见 `examples.md`。
