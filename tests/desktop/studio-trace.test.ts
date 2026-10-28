import { describe, it, expect } from "vitest";
import {
  createStudioTraceCollector,
  renderStudioTraceReport,
  type StudioTraceEvent,
} from "../../src/shared/studio-trace";

function sampleEvents(): StudioTraceEvent[] {
  const base = { turnId: "t1", timestamp: 1000 };
  return [
    { ...base, t: "turn.start" },
    { ...base, timestamp: 1100, t: "request.sent", bytes: 8600, powMs: 812 },
    { ...base, timestamp: 1200, t: "sse.frame", kind: "text", count: 42 },
    { ...base, timestamp: 1250, t: "sse.frame", kind: "think", count: 3 },
    { ...base, timestamp: 1300, t: "sse.frame", kind: "text", count: 300 },
    { ...base, timestamp: 1400, t: "tool.parsed", name: "shell_exec", status: "ok" },
    { ...base, timestamp: 1401, t: "tool.exec", name: "shell_exec", ok: true, durationMs: 1500 },
    { ...base, timestamp: 1500, t: "continuation.decision", reason: "tools-pending", triggered: true },
    { ...base, timestamp: 9000, t: "turn.end", finished: true, stopReason: "completed" },
  ];
}

describe("renderStudioTraceReport", () => {
  it("empty input returns empty string (no placeholder header)", () => {
    expect(renderStudioTraceReport([])).toBe("");
  });

  it("single DONE turn carries duration, bytes, pow, sse aggregates, tool and continuation", () => {
    const out = renderStudioTraceReport(sampleEvents());
    expect(out).toContain("turn 1 (8.0s)  DONE");
    expect(out).toContain("request.sent    8.4KB  pow=812ms");
    expect(out).toContain("sse(chars): text\u00d7342 think\u00d73 tool\u00d70");
    expect(out).toContain("tool.parsed     shell_exec  ok");
    expect(out).toContain("tool.exec       shell_exec  1.5s  ok");
    expect(out).toContain("continuation.decision: tools-pending -> triggered=true");
    expect(out).toContain("turn.end stopReason=completed finished=true");
  });

  it("TRUNCATED turn is flagged", () => {
    const events = sampleEvents().map((e) =>
      e.t === "turn.end" ? { ...e, finished: false, stopReason: "network-error" } : e,
    );
    const out = renderStudioTraceReport(events);
    expect(out).toContain("TRUNCATED");
    expect(out).toContain("<-- \u65ad\u5728\u8fd9\u91cc");
    expect(out).toContain("turn.end stopReason=network-error finished=false");
  });

  it("unfinished turn is OPEN", () => {
    const events = sampleEvents().filter((e) => e.t !== "turn.end");
    const out = renderStudioTraceReport(events);
    expect(out).toContain("OPEN");
    expect(out).not.toContain("\u65ad\u5728\u8fd9\u91cc");
  });

  it("sse frame counts render once only", () => {
    const out = renderStudioTraceReport(sampleEvents());
    const matches = out.match(/sse\(chars\): text\u00d7/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("sse aggregate is labelled chars, not frames (semantics regression)", () => {
    // count 传的是字符数（SseTextStreamExtractor 只暴露累积文本，无帧计数入口）。
    // 若报告退回 "sse: text×N" 的写法，读数会被误读为帧数。
    const out = renderStudioTraceReport(sampleEvents());
    expect(out).toContain('sse(chars):');
    expect(out).not.toMatch(/(?<!chars)\bsse: text/);
    // 342 = 42 + 300，两条 text 事件按字符累加。
    expect(out).toContain('text\u00d7342');
  });

  it("multiple turns are numbered in order and counted independently", () => {
    const events: StudioTraceEvent[] = [
      ...sampleEvents(),
      { turnId: "t2", timestamp: 20000, t: "turn.start" },
      { turnId: "t2", timestamp: 20100, t: "request.sent", bytes: 512 },
      { turnId: "t2", timestamp: 20200, t: "sse.frame", kind: "text", count: 7 },
      { turnId: "t2", timestamp: 20300, t: "turn.end", finished: true, stopReason: "completed" },
    ];
    const out = renderStudioTraceReport(events);
    expect(out).toContain("turn 1 (8.0s)  DONE");
    expect(out).toContain("turn 2 (0.3s)  DONE");
    expect(out).toContain("sse(chars): text\u00d77 think\u00d70 tool\u00d70");
  });

  it("tool.exec omits duration when absent instead of showing a fake 0.0s", () => {
    const events: StudioTraceEvent[] = [
      { turnId: "t1", timestamp: 1, t: "tool.exec", name: "file.read", ok: false },
    ];
    const out = renderStudioTraceReport(events);
    expect(out).toContain("tool.exec       file.read  FAIL");
    // 只断言 tool.exec 行本身：turn 头部时长是轮内首末时间差，单事件轮必然为 0.0s（与上游一致）。
    const execLine = out.split("\n").find((line) => line.includes("tool.exec")) ?? "";
    expect(execLine).not.toContain("0.0s");
  });

  it("request.sent omits pow segment when absent", () => {
    const events: StudioTraceEvent[] = [
      { turnId: "t1", timestamp: 1, t: "request.sent", bytes: 100 },
    ];
    const out = renderStudioTraceReport(events);
    expect(out).toContain("request.sent    100B");
    expect(out).not.toContain("pow=");
  });

  it("branch glyphs: last line uses end-branch, others mid-branch", () => {
    const out = renderStudioTraceReport(sampleEvents());
    const lines = out.split("\n").filter((l) => l.startsWith("  "));
    expect(lines[lines.length - 1]).toContain("\u2514\u2500");
    expect(lines[0]).toContain("\u251c\u2500");
  });

  it("does not mutate input", () => {
    const events = sampleEvents();
    const before = JSON.stringify(events);
    renderStudioTraceReport(events);
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe("createStudioTraceCollector", () => {
  it("record fills timestamp; snapshot returns a copy", () => {
    const c = createStudioTraceCollector();
    c.record({ turnId: "t1", t: "turn.start" });
    expect(c.size()).toBe(1);
    const snap = c.snapshot();
    expect(snap).toHaveLength(1);
    expect(typeof snap[0].timestamp).toBe("number");
    snap.push({ turnId: "x", timestamp: 0, t: "turn.start" });
    expect(c.size()).toBe(1);
  });

  it("explicit timestamp is preserved", () => {
    const c = createStudioTraceCollector();
    c.record({ turnId: "t1", timestamp: 4242, t: "turn.start" });
    expect(c.snapshot()[0].timestamp).toBe(4242);
  });

  it("over capacity drops the oldest", () => {
    const c = createStudioTraceCollector(3);
    for (let i = 0; i < 5; i += 1) {
      c.record({ turnId: `t${i}`, timestamp: i, t: "turn.start" });
    }
    const snap = c.snapshot();
    expect(snap).toHaveLength(3);
    expect(snap.map((e) => e.turnId)).toEqual(["t2", "t3", "t4"]);
  });

  it("clear empties the buffer", () => {
    const c = createStudioTraceCollector();
    c.record({ turnId: "t1", t: "turn.start" });
    c.clear();
    expect(c.size()).toBe(0);
    expect(renderStudioTraceReport(c.snapshot())).toBe("");
  });

  it("invalid maxEvents falls back to 1", () => {
    const c = createStudioTraceCollector(0);
    c.record({ turnId: "a", t: "turn.start" });
    c.record({ turnId: "b", t: "turn.start" });
    expect(c.snapshot().map((e) => e.turnId)).toEqual(["b"]);
  });

  it("collect then render end to end", () => {
    const c = createStudioTraceCollector();
    c.record({ turnId: "t1", t: "turn.start" });
    c.record({ turnId: "t1", t: "request.sent", bytes: 2048 });
    c.record({ turnId: "t1", t: "turn.end", finished: true, stopReason: "completed" });
    const out = renderStudioTraceReport(c.snapshot());
    expect(out).toContain("turn 1");
    expect(out).toContain("DONE");
    expect(out).toContain("2.0KB");
  });
});
