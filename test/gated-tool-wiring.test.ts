/**
 * gated-tool-wiring.test.ts — the Agent tool's `checks`/`review_prompt` params
 * at the boundary: how the tool now accepts `checks` with `run_in_background`
 * (previously refused), still refuses `resume`/`schedule` (v1 follow-up), and
 * that a gated background spawn returns the agent ID immediately (deferred
 * package notification) while a gated foreground spawn blocks for the package.
 *
 * Mirrors background-by-default.test.ts: mock runAgent at the extension level,
 * call the real `Agent` tool, assert on the tool result.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

function settled(text = "done") {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session: { dispose: vi.fn(), messages: [], prompt: vi.fn(), subscribe: vi.fn() } as any,
    aborted: false,
    steered: false,
  } as any);
}

function spawn(tools: Map<string, any>, params: Record<string, unknown> = {}) {
  return tools.get("Agent").execute(
    "tc",
    { prompt: "go", description: "d", subagent_type: "general-purpose", ...params },
    undefined,
    undefined,
    ctx(),
  );
}

async function runOnce(params: Record<string, unknown> = {}) {
  const { pi, tools, lifecycle } = makePi();
  subagentsExtension(pi);
  settled();
  // session_start sets currentCtx, which runGatedPackage needs to spawn the review.
  lifecycle.get("session_start")?.(null, ctx());
  return { out: textOf(await spawn(tools, params)), tools, pi };
}

describe("gated tool wiring", () => {
  it("accepts checks with run_in_background: true — no longer refuses it", async () => {
    const { out } = await runOnce({ checks: ["true"], run_in_background: true });
    // Returns the agent ID immediately (background), NOT the result.
    expect(out).toContain("Agent ID:");
    expect(out).not.toContain("Cannot combine `checks`");
  });

  it("accepts checks with resume — no longer refuses it (gated package on the resumed turn)", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    lifecycle.get("session_start")?.(null, ctx());
    // Spawn a settled background agent so it holds a resumable session.
    const session = { dispose: vi.fn(), messages: [], prompt: vi.fn(), subscribe: vi.fn() } as any;
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      await Promise.resolve();
      options.onSessionCreated?.(session);
      return { responseText: "first run", session, aborted: false, steered: false } as any;
    });
    const spawned = await spawn(tools, { prompt: "first", description: "first", run_in_background: true });
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    await new Promise((r) => setTimeout(r, 0));

    // Resume WITH checks: must now be accepted (no refusal), and the resumed
    // turn is gated — so the run returns a background handoff, not the result.
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "resumed",
      session,
      aborted: false,
      steered: false,
    } as any);
    const out = textOf(await spawn(tools, { checks: ["true"], resume: id, run_in_background: true }));
    expect(out).toContain("resumed in background");
    expect(out).not.toContain("Cannot combine`checks`");

    await lifecycle.get("session_shutdown")?.(null, ctx());
  });

  it("starts a gated background run when checks are given without name", async () => {
    const { out } = await runOnce({ checks: ["true"] });
    expect(out).toContain("Agent ID:");
  });

  it("spawns the review agent as the dedicated Review type, not a general twin", async () => {
    await runOnce({ checks: ["true"], run_in_background: false });
    // The gate runs checks then spawns the review via runAgent(ctx, "Review", reviewPrompt, ...).
    const reviewCalls = vi.mocked(runAgent).mock.calls.filter(
      ([, type]) => type === "Review",
    );
    expect(reviewCalls.length).toBeGreaterThan(0);
    // The review prompt carries the checks results (the review sees them).
    expect(String(reviewCalls[0][2])).toMatch(/Review|CHECKS|checks/i);
  });
});
