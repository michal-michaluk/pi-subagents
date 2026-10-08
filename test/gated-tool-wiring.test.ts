/**
 * gated-tool-wiring.test.ts — the Agent tool's `checks`/`review_prompt` params
 * at the boundary: how the tool now accepts `checks` in both a detached and a
 * foreground run (previously refused), still refuses `resume`/`schedule` (v1
 * follow-up), and that a gated background spawn returns the agent ID
 * immediately (deferred package notification) while a gated foreground spawn
 * blocks for the package.
 *
 * Mirrors background-by-default.test.ts: mock runAgent at the extension level,
 * call the real `Agent` tool, assert on the tool result.
 */
import { describe, expect, it, vi } from "vitest";
import { setDefaultsDisabled, setFallbackSubagent } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

// Deterministic agent roster: the extension calls loadCustomAgents on every
// spawn, so control what it returns instead of reading the environment's real
// agent dirs (defaults-disabled global config).
const userAgents = new Map<string, AgentConfig>();
vi.mock("../src/custom-agents.js", async () => ({
  loadCustomAgents: vi.fn(() => userAgents),
}));

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    isolated: false,
    ...overrides,
  };
}

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

function ctx(mode: "tui" | "print" = "print") {
  return {
    mode,
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
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

function spawn(tools: Map<string, any>, params: Record<string, unknown> = {}, mode: "tui" | "print" = "print") {
  return tools.get("Agent").execute(
    "tc",
    { prompt: "go", description: "d", subagent_type: "general-purpose", ...params },
    undefined,
    undefined,
    ctx(mode),
  );
}

async function runOnce(params: Record<string, unknown> = {}, mode: "tui" | "print" = "print") {
  const { pi, tools, lifecycle } = makePi();
  subagentsExtension(pi);
  settled();
  // Deterministic registry regardless of the machine: force defaults off and no
  // fallbackSubagent so only the mocked userAgents roster drives resolution.
  setDefaultsDisabled(true);
  setFallbackSubagent(undefined);
  // session_start sets currentCtx, which runGatedPackage needs to spawn the review.
  lifecycle.get("session_start")?.(null, ctx(mode));
  return { out: textOf(await spawn(tools, params, mode)), tools, pi };
}

describe("gated tool wiring", () => {
  it("accepts checks in a detached (tui) run — no longer refuses them", async () => {
    const { out } = await runOnce({ checks: ["true"] }, "tui");
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
    const spawned = await spawn(tools, { prompt: "first", description: "first" }, "tui");
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
    const out = textOf(await spawn(tools, { checks: ["true"], resume: id }, "tui"));
    expect(out).toContain("resumed in background");
    expect(out).not.toContain("Cannot combine`checks`");

    await lifecycle.get("session_shutdown")?.(null, ctx());
  });

  it("starts a gated detached run when checks are given without name", async () => {
    const { out } = await runOnce({ checks: ["true"] }, "tui");
    expect(out).toContain("Agent ID:");
  });

  it("spawns the review agent as the dedicated review type, not a general twin", async () => {
    // A user `review` agent exists → resolves to it, not a `general` twin.
    userAgents.set("review", makeAgentConfig({ name: "review" }));
    await runOnce({ checks: ["true"] });
    // The gate runs checks then spawns the review via runAgent(ctx, type, reviewPrompt, ...).
    const reviewCalls = vi.mocked(runAgent).mock.calls.filter(
      ([, type]) => type === "review" || type === "Review",
    );
    expect(reviewCalls.length).toBeGreaterThan(0);
    // The review prompt carries the checks results (the review sees them).
    expect(String(reviewCalls[0][2])).toMatch(/CHECKS|checks/i);
  });

  it("falls back the review dispatch to the general twin when no review agent exists", async () => {
    // No `review`/`Review` agent, no fallbackSubagent → the review must still
    // dispatch (never error) to the general-purpose twin.
    userAgents.clear();
    await runOnce({ checks: ["true"] });
    const reviewCalls = vi.mocked(runAgent).mock.calls.filter(
      ([, type]) => type === "general-purpose",
    );
    // The task spawn is gated as general-purpose too; the review twin adds a
    // second general-purpose spawn. Assert it happened (no error, not hung).
    expect(reviewCalls.length).toBeGreaterThan(1);
  });
});
