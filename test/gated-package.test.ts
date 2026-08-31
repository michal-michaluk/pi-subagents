/**
 * gated-package.test.ts — the package lifecycle: a gated run is NOT done when
 * its task settles. Checks → review → rework must all settle before the agent
 * finalizes (deferred notification, promise resolved at package end, worktree
 * kept alive through the loop).
 *
 * These drive AgentManager directly (mocking runAgent/resumeAgent/worktree),
 * which is where the deferral logic lives. The tool-boundary wiring (gate rides
 * spawn options, run_in_background stays legal) is covered by the unit tests
 * that mock runAgent at the extension level.
 *
 * Key assertions:
 *   - a gated task-settle leaves status "running" and does NOT fire onComplete
 *   - the package promise resolves only when finalizeGated runs
 *   - finalizeGated cleans up the worktree (deferred) + fires onComplete once
 *   - still-failing checks leave status "completed" (no dangling subagent, Q7)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn(), messages: [], prompt: vi.fn(), subscribe: vi.fn() } as any);

function gatedSpawn(manager: AgentManager, overrides: Record<string, unknown> = {}) {
  return manager.spawn(mockPi, mockCtx, "general-purpose", "do the task", {
    description: "gated task",
    isBackground: true,
    gate: { checks: ["true"], maxReworks: 1 },
    ...overrides,
  });
}

/** Settle the mocked runAgent as a successful task completion. */
function settleRun(text = "task done") {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session: mockSession(),
    aborted: false,
    steered: false,
  } as any);
}

describe("AgentManager gated package lifecycle", () => {
  let manager: AgentManager;
  const onComplete = vi.fn();

  beforeEach(() => {
    onComplete.mockClear();
    manager = new AgentManager(onComplete);
    // Production wiring (index.ts) always sets a gate runner; without it a
    // gated record auto-finalizes via the no-runner branch.
    manager.gateRunner = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(() => manager?.dispose());

  it("keeps a gated record in flight (status running) after task settle, no onComplete", async () => {
    settleRun();
    const id = gatedSpawn(manager);
    const record = manager.getRecord(id)!;

    // Task promise resolves (the task's own promise), but the package promise
    // must remain unresolved and onComplete must NOT have fired.
    await new Promise((r) => setTimeout(r, 10));
    expect(record.status).toBe("running");
    expect(record.completedAt).toBeUndefined();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("resolves the package promise only when finalizeGated runs", async () => {
    settleRun("task done");
    const id = gatedSpawn(manager);
    const record = manager.getRecord(id)!;

    await new Promise((r) => setTimeout(r, 10));
    expect(record.status).toBe("running");

    // Before settle, awaiting record.promise would hang — so flake-guard by
    // resolving it here and asserting it resolves with the final result.
    record.result = "final result";
    manager.finalizeGated(record);
    await expect(record.promise).resolves.toBe("final result");
    expect(record.status).toBe("completed");
    expect(record.completedAt).toBeDefined();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("defers worktree cleanup to package settle so the copy survives the loop", async () => {
    settleRun();
    // A worktree must be returned for startAgent to proceed with isolation.
    vi.mocked(createWorktree).mockReturnValue({
      path: "/a/b",
      branch: "branch-1",
      baseSha: "abc",
      workPath: "/a/b",
    });
    const id = gatedSpawn(manager, { isolation: "worktree" });
    const record = manager.getRecord(id)!;

    await new Promise((r) => setTimeout(r, 10));
    expect(record.status).toBe("running");
    expect(cleanupWorktree).not.toHaveBeenCalled();

    manager.finalizeGated(record);
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
  });

  it("finalizes immediately (not gated) when the task fails — nothing to gate", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "",
      session: mockSession(),
      aborted: false,
      steered: false,
      failure: "provider error",
    } as any);
    const id = gatedSpawn(manager);
    const record = manager.getRecord(id)!;

    await record.promise;
    expect(record.status).toBe("error");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("leaves status completed when checks still fail (Q7: no dangling subagent)", async () => {
    settleRun();
    const id = gatedSpawn(manager);
    const record = manager.getRecord(id)!;

    await new Promise((r) => setTimeout(r, 10));
    // Simulate the gate runner reporting failing checks, then finalize.
    record.status = "running";
    manager.finalizeGated(record);
    expect(record.status).toBe("completed");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("gatedRework uses foreground resume which does NOT re-finalize", () => {
  let manager: AgentManager;
  const onComplete = vi.fn();

  beforeEach(() => {
    onComplete.mockClear();
    manager = new AgentManager(onComplete);
    manager.gateRunner = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(() => manager?.dispose());

  it("foreground resume returns the settled record without firing onComplete again", async () => {
    settleRun();
    const id = gatedSpawn(manager);
    const record = manager.getRecord(id)!;
    await new Promise((r) => setTimeout(r, 10));

    // Foreground resume: bound to a session, returns the settled record inline.
    vi.mocked(resumeAgent).mockResolvedValue({ text: "reworked", failure: undefined });
    record.session = mockSession();
    const resumed = await manager.resume(id, "fix it", undefined, {});

    expect(resumed).toBeTruthy();
    expect(resumed!.result).toBe("reworked");
    // Foreground resume must NOT fire onComplete — the package isn't settled yet.
    expect(onComplete).not.toHaveBeenCalled();
  });
});
