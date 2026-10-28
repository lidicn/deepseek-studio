import { describe, it, expect } from "vitest";
import {
  STUDIO_CONTEXT_CHAR_LIMIT,
  describeStudioBudget,
  estimateMessagesChars,
  evaluateStudioBudget,
  evaluateStudioBudgetForMessages,
} from "../../src/shared/studio-context-budget";

describe("evaluateStudioBudget", () => {
  it("ratio below 50% stays ok with positive remaining", () => {
    const state = evaluateStudioBudget(4, 10_000, STUDIO_CONTEXT_CHAR_LIMIT);
    expect(state.level).toBe("ok");
    expect(state.estimated).toBe(10_000);
    expect(state.remaining).toBe(STUDIO_CONTEXT_CHAR_LIMIT - 10_000);
    expect(state.remaining).toBeGreaterThan(0);
  });

  it("exactly 50% is warn (boundary inclusive)", () => {
    const state = evaluateStudioBudget(4, STUDIO_CONTEXT_CHAR_LIMIT * 0.5, STUDIO_CONTEXT_CHAR_LIMIT);
    expect(state.level).toBe("warn");
  });

  it("exactly 80% is still warn; just above is critical", () => {
    expect(evaluateStudioBudget(4, STUDIO_CONTEXT_CHAR_LIMIT * 0.8, STUDIO_CONTEXT_CHAR_LIMIT).level).toBe("warn");
    expect(
      evaluateStudioBudget(4, Math.floor(STUDIO_CONTEXT_CHAR_LIMIT * 0.8) + 1, STUDIO_CONTEXT_CHAR_LIMIT).level,
    ).toBe("critical");
  });

  it("over limit reports negative remaining instead of clamping", () => {
    const state = evaluateStudioBudget(4, STUDIO_CONTEXT_CHAR_LIMIT + 500, STUDIO_CONTEXT_CHAR_LIMIT);
    expect(state.level).toBe("critical");
    expect(state.remaining).toBe(-500);
  });
});

describe("estimateMessagesChars", () => {
  it("counts string content", () => {
    const n = estimateMessagesChars([
      { role: "user", content: "abcd" },
      { role: "assistant", content: "xy" },
    ]);
    expect(n).toBe(6);
  });

  it("counts array-of-parts content and ignores non-text parts", () => {
    const n = estimateMessagesChars([
      { role: "user", content: [{ type: "text", text: "abc" }, { type: "image_url", image_url: {} }] },
      { role: "assistant", content: [{ type: "text", text: "de" }] },
    ]);
    expect(n).toBe(5);
  });

  it("skips null / non-object entries and unknown content shapes", () => {
    const n = estimateMessagesChars([null, 42, "str", { role: "user" }, { role: "user", content: 7 }]);
    expect(n).toBe(0);
  });
});

describe("evaluateStudioBudgetForMessages", () => {
  it("uses message count and estimated chars together", () => {
    const messages = [
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(100) },
    ];
    const state = evaluateStudioBudgetForMessages(messages, 200);
    expect(state.level).toBe("critical");
    expect(state.estimated).toBe(200);
    expect(state.remaining).toBe(0);
  });
});

describe("describeStudioBudget", () => {
  it("ok level returns empty string (no noise)", () => {
    expect(describeStudioBudget({ level: "ok", estimated: 10, remaining: 100 })).toBe("");
  });

  it("warn mentions over half", () => {
    const text = describeStudioBudget({ level: "warn", estimated: 33_000, remaining: 31_000 });
    expect(text).toContain("\u534a");
    expect(text).toContain("33k");
  });

  it("critical suggests a new session", () => {
    const text = describeStudioBudget({ level: "critical", estimated: 60_000, remaining: 4_000 });
    expect(text).toContain("\u65b0\u4f1a\u8bdd");
  });
});
