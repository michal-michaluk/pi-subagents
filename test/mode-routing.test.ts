/**
 * mode-routing.test.ts — the background/foreground decision follows pi's run
 * mode, asserted at the tool boundary.
 *
 * `run_in_background` no longer exists: the model cannot choose. `tui` and `rpc`
 * sessions detach (the call returns an ID immediately and notifies on
 * completion); `json`, `print`, and an unset mode block and return the result
 * inline. `documented-defaults.test.ts` pins the pure `modeRunsInBackground`
 * mapping; this pins what the real `Agent` tool actually does with each mode,
 * plus the two schemas that must no longer advertise the removed parameter.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

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

function ctx(mode?: "tui" | "rpc" | "json" | "print") {
  return {
    mode,
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

const settled = (text: string) =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  } as any);

function agentTool() {
  const { pi, tools } = makePi();
  subagentsExtension(pi);
  return tools.get("Agent");
}

const priorGlobal = (globalThis as any)[MANAGER_KEY];
const tmpDirs: string[] = [];

/** A hermetic config root holding one nested-spawnable agent. */
function nestedConfigRoot(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mode-routing-"));
  tmpDirs.push(cwd);
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "agents", "worker.md"), "---\ndescription: Worker\ntools: read\n---\nWork.\n");
  return cwd;
}

afterEach(() => {
  if (priorGlobal === undefined) delete (globalThis as any)[MANAGER_KEY];
  else (globalThis as any)[MANAGER_KEY] = priorGlobal;
  vi.mocked(runAgent).mockReset();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("background follows the run mode", () => {
  it.each([
    ["tui" as const],
    ["rpc" as const],
  ])("mode %s detaches: returns an ID and notifies, never the payload", async (mode) => {
    delete (globalThis as any)[MANAGER_KEY];
    const tool = agentTool();
    settled("THE-PAYLOAD");

    const out = textOf(await tool.execute(
      "tc",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined,
      undefined,
      ctx(mode),
    ));

    expect(out).toContain("started in background");
    expect(out).toContain("Agent ID:");
    // The whole point of detaching: the orchestrator does NOT get the output
    // here — it arrives later as a notification preview.
    expect(out).not.toContain("THE-PAYLOAD");

    const id = /Agent ID: (\S+)/.exec(out)![1];
    const record = (globalThis as any)[MANAGER_KEY].getRecord(id);
    expect(record.isBackground).toBe(true);
  });

  it.each([
    ["print" as const],
    ["json" as const],
    [undefined],
  ])("mode %s blocks and returns the result inline", async (mode) => {
    const tool = agentTool();
    settled("THE-PAYLOAD");

    const result = await tool.execute(
      "tc",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined,
      undefined,
      ctx(mode),
    );

    expect(textOf(result)).toContain("Agent completed");
    expect(textOf(result)).toContain("THE-PAYLOAD");
    expect(textOf(result)).not.toContain("started in background");

    const id = result.details?.agentId;
    expect(id).toBeTruthy();
    const record = (globalThis as any)[MANAGER_KEY].getRecord(id);
    expect(record.isBackground).toBe(false);
  });
});

describe("the removed parameter is gone from every schema", () => {
  it("is absent from the top-level Agent tool schema", () => {
    const props = agentTool().parameters?.properties ?? {};
    expect(props).not.toHaveProperty("run_in_background");
  });

  it("is absent from the nested delegation Agent schema", () => {
    const manager: NestedAgentManager = {
      spawn: vi.fn(),
      spawnAndWait: vi.fn(),
      getRecord: vi.fn(),
      resume: vi.fn(),
    } as any;
    const [nestedAgent] = createNestedSubagentTools({
      manager,
      pi: {} as any,
      parentAgentId: "parent-1",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: nestedConfigRoot(),
    });
    const props = nestedAgent.parameters?.properties ?? {};
    expect(props).not.toHaveProperty("run_in_background");
  });

  it("resolves a nested spawn to foreground because a child ctx has mode 'print'", async () => {
    // Child sessions bind without a mode, so a nested spawn is foreground; a
    // detached child would be stopped by `abortOwnedChildren` when its parent
    // settles. The passed `run_in_background` is inert — the mode decides.
    const spawn = vi.fn();
    const spawnAndWait = vi.fn(async () => ({
      id: "child-1",
      record: { id: "child-1", status: "completed", result: "done", parentAgentId: "parent-1" },
    }));
    const manager: NestedAgentManager = {
      spawn,
      spawnAndWait,
      getRecord: vi.fn(),
      resume: vi.fn(),
    } as any;
    const [nestedAgent] = createNestedSubagentTools({
      manager,
      pi: {} as any,
      parentAgentId: "parent-1",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: nestedConfigRoot(),
    });

    await nestedAgent.execute(
      "call-1",
      { subagent_type: "worker", description: "nested", prompt: "do work", run_in_background: true } as any,
      undefined,
      undefined,
      ctx("print"),
    );

    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });
});
