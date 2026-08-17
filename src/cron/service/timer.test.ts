// Cron service timer tests cover timer scheduling, cancellation, and wakeups.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as jobPrecheck from "../../cron/job-precheck.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState as createCronServiceStateBase } from "../../cron/service/state.js";
import { executeJobCore, onTimer } from "../../cron/service/timer.test-support.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronJob } from "../../cron/types.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { findTaskByRunId, listTaskRecordsUnsorted } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-seam",
});

function createCronServiceState(
  params: Parameters<typeof createCronServiceStateBase>[0],
): ReturnType<typeof createCronServiceStateBase> {
  return createCronServiceStateBase({ defaultAgentId: "main", ...params });
}

function createDueMainJob(params: { now: number; wakeMode: CronJob["wakeMode"] }): CronJob {
  return {
    id: "main-heartbeat-job",
    name: "main heartbeat job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "main",
    wakeMode: params.wakeMode,
    payload: { kind: "systemEvent", text: "heartbeat seam tick" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createDueIsolatedAgentJob(params: { now: number }): CronJob {
  return {
    id: "isolated-agent-job",
    agentId: "finn",
    name: "isolated agent job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run isolated cron" },
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createDueCommandJob(params: { now: number }): CronJob {
  return {
    id: "command-job",
    agentId: "finn",
    name: "command job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "command", argv: ["sh", "-lc", "echo ok"] },
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createDueScriptJob(params: {
  now: number;
  sessionTarget?: "main" | "isolated";
  pacing?: CronJob["pacing"];
}): CronJob {
  return {
    id: "script-job",
    agentId: "finn",
    name: "script job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    pacing: params.pacing,
    sessionTarget: params.sessionTarget ?? "isolated",
    wakeMode: "now",
    payload: {
      kind: "script",
      script: "return { notify: 'done' }",
      timeoutSeconds: 300,
      toolBudget: 50,
    },
    state: { nextRunAtMs: params.now - 1, triggerState: { revision: 1 } },
  };
}

function findCronTaskByBaseRunId(baseRunId: string) {
  return (
    findTaskByRunId(baseRunId) ??
    listTaskRecordsUnsorted().find((task) => task.runId?.startsWith(`${baseRunId}:`))
  );
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron service timer seam coverage", () => {
  it("routes main cron jobs to the owning agent's main session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const job = {
      ...createDueMainJob({ now, wakeMode: "now" }),
      sessionKey: "agent:main-pr-router:main",
      state: { runningAtMs: now },
    };
    const sessionStorePath = path.join(path.dirname(path.dirname(storePath)), "sessions.json");
    await upsertSessionEntryCore(
      { storePath: sessionStorePath, sessionKey: "agent:main-pr-router:main" },
      {
        sessionId: "main-pr-router-session",
        updatedAt: now,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "discord", to: "channel-1", accountId: "default" },
        }),
      },
    );

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      defaultAgentId: "main-pr-router",
      resolveSessionStorePath: () => sessionStorePath,
      enqueueSystemEvent,
      requestHeartbeat,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({ status: "ok" });
    expect(result.sessionKey).toBeUndefined();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: "main-pr-router",
      contextKey: "cron:main-heartbeat-job",
      deliveryContext: { channel: "discord", to: "channel-1", accountId: "default" },
    });
    expect(runHeartbeatOnce).toHaveBeenCalledWith({
      source: "cron",
      intent: "immediate",
      reason: "cron:main-heartbeat-job",
      agentId: "main-pr-router",
      owningCronJobMarker: undefined,
      heartbeat: { target: "last" },
    });
  });

  it("persists the next schedule and hands off next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const jobWithoutExplicitOwner = createDueMainJob({ now, wakeMode: "next-heartbeat" });
    delete jobWithoutExplicitOwner.sessionKey;
    await writeCronStoreSnapshot({ storePath, jobs: [jobWithoutExplicitOwner] });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      defaultAgentId: "stale-default",
      resolveDefaultAgentId: () => "ops",
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: "ops",
      contextKey: "cron:main-heartbeat-job",
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "cron",
      intent: "event",
      reason: "cron:main-heartbeat-job",
      agentId: "ops",
      heartbeat: { target: "last" },
    });

    const persisted = await loadCronStore(storePath);
    const job = persisted.jobs[0];
    if (!job) {
      throw new Error("expected persisted heartbeat cron job");
    }
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBe(now + 60_000);
    const task = findCronTaskByBaseRunId(`cron:main-heartbeat-job:${now}`);
    if (!task) {
      throw new Error("expected cron task ledger record");
    }
    expect(task.runtime).toBe("cron");
    expect(task.sourceId).toBe("main-heartbeat-job");
    expect(task.agentId).toBe("ops");
    expect(task.ownerKey).toBe("");
    expect(task.scopeKind).toBe("system");
    expect(task.childSessionKey).toBeUndefined();
    expect(task.runId).toMatch(new RegExp(`^cron:main-heartbeat-job:${now}:`));
    expect(task.label).toBe("main heartbeat job");
    expect(task.task).toBe("main heartbeat job");
    expect(task.status).toBe("succeeded");
    expect(task.deliveryStatus).toBe("not_applicable");
    expect(task.notifyPolicy).toBe("silent");
    expect(task.startedAt).toBe(now);
    expect(task.lastEventAt).toBe(now);
    expect(task.endedAt).toBe(now);
    expect(task.cleanupAfter).toBeUndefined();

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    const positiveDelays = delays.filter((delay) => delay > 0);
    expect(positiveDelays.length).toBeGreaterThan(0);

    timeoutSpy.mockRestore();
  });

  it("uses the persisted execution timestamp for the canonical timer task", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    let clock = now;
    let persistedReservation: number | undefined;
    let liveReservation: number | undefined;
    let liveError: string | undefined;
    let emittedStartedAt: number | undefined;
    let reservedAt: number | undefined;
    const job = createDueIsolatedAgentJob({ now });
    job.state.lastError = "previous failure";
    await writeCronStoreSnapshot({
      storePath,
      jobs: [job],
    });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => clock++,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        persistedReservation = (await loadCronStore(storePath)).jobs[0]?.state.runningAtMs;
        liveReservation = state.store?.jobs[0]?.state.runningAtMs;
        liveError = state.store?.jobs[0]?.state.lastError;
        return { status: "ok" as const };
      }),
      onEvent: (event) => {
        if (event.action === "started") {
          emittedStartedAt = event.runAtMs;
        }
      },
    });
    const database = openOpenClawStateDatabase().db;
    database.function("observe_timer_reservation", (stateJson) => {
      if (typeof stateJson === "string") {
        const marker = (JSON.parse(stateJson) as CronJob["state"]).queuedAtMs;
        if (reservedAt === undefined && typeof marker === "number") {
          reservedAt = marker;
        }
      }
      return 0;
    });
    database.exec(`
      CREATE TEMP TRIGGER observe_timer_reservation
      AFTER UPDATE ON cron_jobs
      WHEN NEW.job_id = '${job.id}'
      BEGIN
        SELECT observe_timer_reservation(NEW.state_json);
      END;
    `);

    try {
      await onTimer(state);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS observe_timer_reservation");
    }

    expect(reservedAt).toEqual(expect.any(Number));
    expect(persistedReservation).toEqual(expect.any(Number));
    expect(reservedAt).not.toBe(persistedReservation);
    expect(liveReservation).toBe(persistedReservation);
    expect(liveError).toBeUndefined();
    expect(emittedStartedAt).toBe(persistedReservation);
    expect(
      findCronTaskByBaseRunId(`cron:isolated-agent-job:${persistedReservation}`),
    ).toMatchObject({
      startedAt: emittedStartedAt,
      status: "succeeded",
    });
  });

  it("finalizes quiet trigger tasks only after cron state persists", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const job = {
      ...createDueIsolatedAgentJob({ now }),
      trigger: { script: "json({ fire: false })" },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    let terminalStatePersisted = false;
    let finalizedAfterPersist = false;
    const finalize = taskExecutor.finalizeTaskRunByRunIdCore;
    const finalizeSpy = vi
      .spyOn(taskExecutor, "finalizeTaskRunByRunIdCore")
      .mockImplementation((params) => {
        const persistedJob = openOpenClawStateDatabase()
          .db.prepare(
            "SELECT running_at_ms AS runningAtMs, next_run_at_ms AS nextRunAtMs FROM cron_jobs WHERE store_key = ? AND job_id = ?",
          )
          .get(cronStoreKey(storePath), job.id) as {
          runningAtMs: number | null;
          nextRunAtMs: number | null;
        };
        terminalStatePersisted =
          persistedJob.runningAtMs === null && (persistedJob.nextRunAtMs ?? 0) > now;
        finalizedAfterPersist = terminalStatePersisted;
        return finalize(params);
      });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      evaluateCronTrigger: vi.fn(async () => ({ kind: "evaluated" as const, fire: false })),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    try {
      await onTimer(state);
      expect(finalizedAfterPersist).toBe(true);
      const task = findCronTaskByBaseRunId(`cron:${job.id}:${now}`);
      expect(task).toMatchObject({ status: "succeeded" });
      expect(task?.detail).toEqual({
        storeKey: cronStoreKey(storePath),
        triggerFired: false,
        triggerStateChanged: false,
      });
    } finally {
      finalizeSpy.mockRestore();
    }
  });

  it.each(["command", "script", "systemEvent", "heartbeat"] as const)(
    "does not run a %s payload when trigger evaluation resolves after cancellation",
    async (kind) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-07-27T12:00:00.000Z");
      const evaluation = createDeferred<{
        kind: "evaluated";
        fire: true;
        state: { revision: number };
      }>();
      const evaluateCronTrigger = vi.fn(() => evaluation.promise);
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
      const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent,
        requestHeartbeat,
        evaluateCronTrigger,
        runCommandJob,
        runScriptJob,
        runIsolatedAgentJob,
      });
      const baseJob =
        kind === "command"
          ? createDueCommandJob({ now })
          : kind === "script"
            ? createDueScriptJob({ now })
            : kind === "heartbeat"
              ? {
                  ...createDueMainJob({ now, wakeMode: "next-heartbeat" }),
                  payload: { kind: "heartbeat" as const },
                }
              : createDueMainJob({ now, wakeMode: "next-heartbeat" });
      const job: CronJob = {
        ...baseJob,
        trigger: { script: "json({ fire: true })" },
      };
      const controller = new AbortController();

      const result = executeJobCore(state, job, controller.signal);
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      controller.abort(new Error("operator cancelled the scheduled run"));
      evaluation.resolve({ kind: "evaluated", fire: true, state: { revision: 2 } });

      await expect(result).resolves.toMatchObject({ status: "error" });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
      expect(runCommandJob).not.toHaveBeenCalled();
      expect(runScriptJob).not.toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    },
  );

  it("runs command cron jobs without isolated agent setup", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const runCommandJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "command ok",
    }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      runCommandJob,
    });
    const job = createDueCommandJob({ now });

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({ status: "ok", summary: "command ok" });
    expect(runCommandJob).toHaveBeenCalledWith({
      job,
      abortSignal: undefined,
    });
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("records an execution error when script payloads are disabled", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: false } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob,
    });

    await expect(executeJobCore(state, createDueScriptJob({ now }))).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("the operator set cron.triggers.enabled: false"),
    });
    expect(runScriptJob).not.toHaveBeenCalled();
  });

  it("blocks a host-shell precheck when cron.triggers.enabled is not true", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      // triggers disabled: unattended host-shell execution must be denied.
      cronConfig: { triggers: { enabled: false } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    const job: CronJob = {
      ...createDueMainJob({ now, wakeMode: "now" }),
      payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] as const },
      precheck: { kind: "exec", command: "exit 2" },
    };

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("cron.triggers.enabled=true"),
    });
    // The gate must short-circuit before any agent payload runs.
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("allows a host-shell precheck to skip the payload when triggers are enabled", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    // This path needs triggers + a permitting exec security (host approvals often
    // default allowlist/full). Policy denies without shell spawn are covered in
    // job-precheck.test.ts. Here we prove no-work precheck skips the payload.
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      ...createDueMainJob({ now, wakeMode: "now" }),
      // exit code 2 = NO_WORK under the default exit-code contract.
      payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] as const },
      precheck: { kind: "exec", command: "exit 2" },
    };

    const result = await executeJobCore(state, job);
    const agent = state.deps.runIsolatedAgentJob as ReturnType<typeof vi.fn>;

    // Host exec policy may deny without spawning; either path must not run payload/agent.
    if (result.status === "error") {
      expect(String(result.error)).toContain("precheck-policy-denied");
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({
      status: "skipped",
      error: "precheck-no-work",
      summary: "precheck-no-work",
    });
    // No payload/model side effect on a no-work skip.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
  });

  it("persists precheck-skipped-error through onTimer when onError=skip (distinct from no-work)", async () => {
    // ClawSweeper P2: failed probes with onError=skip must not look like quiet no-work.
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-15T07:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const spy = vi.spyOn(jobPrecheck, "runCronJobPrecheck").mockResolvedValue({
      decision: "skip",
      reason: "precheck-skipped-error",
      exitCode: 7,
      stdout: "",
      stderr: "boom",
    } as Awaited<ReturnType<typeof jobPrecheck.runCronJobPrecheck>>);
    try {
      const job: CronJob = {
        ...createDueIsolatedAgentJob({ now }),
        id: "precheck-skipped-error-persist",
        payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] },
        precheck: { kind: "exec", command: "exit 7", onError: "skip" },
      };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });

      await onTimer(state);

      const stored = await loadCronStore(storePath);
      const persisted = stored.jobs.find((entry) => entry.id === "precheck-skipped-error-persist");
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(persisted?.state.lastStatus).toBe("skipped");
      expect(persisted?.state.lastError ?? "").toContain("precheck-skipped-error");
      expect(persisted?.state.lastError ?? "").not.toContain("precheck-no-work");
    } finally {
      spy.mockRestore();
    }
  });

  it("persists precheck-no-work through onTimer without an agent turn", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const job: CronJob = {
      ...createDueIsolatedAgentJob({ now }),
      id: "precheck-no-work-persist",
      payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] as const },
      precheck: { kind: "exec", command: "exit 2" },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const stored = await loadCronStore(storePath);
    const persisted = stored.jobs.find((entry) => entry.id === "precheck-no-work-persist");
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    // Policy-deny vs no-work both prove zero agent turns; prefer no-work when allowed.
    if (persisted?.state.lastStatus === "error") {
      expect(persisted.state.lastError ?? "").toContain("precheck-policy-denied");
      return;
    }
    expect(persisted?.state.lastStatus).toBe("skipped");
    expect(persisted?.state.lastError ?? "").toContain("precheck-no-work");
    expect(persisted?.state.consecutiveSkipped ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("passes canonical effective cron owner into precheck authz (sessionKey-owned)", async () => {
    // ClawSweeper P1: agent-less jobs owned via sessionKey must not pass undefined
    // job.agentId into exec approvals (generic default entry). Timer must resolve
    // resolveCronJobEffectiveAgentId and forward that owner for tools + approvals.
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-15T04:00:00.000Z");
    const spy = vi.spyOn(jobPrecheck, "runCronJobPrecheck").mockResolvedValue({
      decision: "skip",
      reason: "precheck-no-work",
      exitCode: 2,
      stdout: "NO_WORK\n",
      stderr: "",
    } as Awaited<ReturnType<typeof jobPrecheck.runCronJobPrecheck>>);
    try {
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        defaultAgentId: "main",
      });
      const job: CronJob = {
        ...createDueMainJob({ now, wakeMode: "now" }),
        // Explicit agent-less: ownership comes from sessionKey agent:ops:...
        agentId: undefined,
        sessionKey: "agent:ops:main",
        payload: {
          ...createDueMainJob({ now, wakeMode: "now" }).payload,
          toolsAllow: ["*"],
        },
        precheck: { kind: "exec", command: "exit 2" },
      };
      const result = await executeJobCore(state, job);
      expect(spy).toHaveBeenCalled();
      const authz = spy.mock.calls[0]?.[1]?.authz as { agentId?: string } | undefined;
      expect(authz?.agentId).toBe("ops");
      expect(result).toMatchObject({ status: "skipped", error: "precheck-no-work" });
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["systemEvent", "heartbeat"] as const)(
    "denies host-shell precheck for capless %s payload (no toolsAllow)",
    async (kind) => {
      // ClawSweeper P1: non-tool payloads used to keep toolsAllow undefined, which
      // the precheck runner treated as unrestricted host exec. Fail closed instead.
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-08-17T04:00:00.000Z");
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent,
        requestHeartbeat,
        runIsolatedAgentJob,
      });
      const base =
        kind === "heartbeat"
          ? {
              ...createDueMainJob({ now, wakeMode: "next-heartbeat" }),
              payload: { kind: "heartbeat" as const },
            }
          : createDueMainJob({ now, wakeMode: "now" });
      const job: CronJob = {
        ...base,
        id: `precheck-capless-${kind}`,
        // Explicitly capless — no toolsAllow stamped on payload
        payload: { ...base.payload },
        precheck: { kind: "exec", command: "echo should-not-run; exit 0" },
      };
      Reflect.deleteProperty(job.payload, "toolsAllow");

      const result = await executeJobCore(state, job);
      expect(result.status).toBe("error");
      expect(result).toMatchObject({ status: "error" });
      expect(String("error" in result ? result.error : "")).toMatch(
        /toolsAllow|precheck-policy-denied/,
      );
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
    },
  );

  it("persists precheck-policy-denied through onTimer without an agent turn", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:30:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const job: CronJob = {
      ...createDueIsolatedAgentJob({ now }),
      id: "precheck-denied-persist",
      payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] },
      precheck: { kind: "exec", command: "exit 0" },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      // triggers off => shared host-shell admission denies before spawn
      cronConfig: { triggers: { enabled: false } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const stored = await loadCronStore(storePath);
    const persisted = stored.jobs.find((entry) => entry.id === "precheck-denied-persist");
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(persisted?.state.lastStatus).toBe("error");
    expect(persisted?.state.lastError ?? "").toMatch(
      /precheck-policy-denied|cron\.triggers\.enabled=true/,
    );
  });

  it.each([
    ["now", "immediate"],
    ["next-heartbeat", "event"],
  ] as const)("turns a main script notify and %s wake into one event", async (wake, intent) => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const job = createDueScriptJob({ now, sessionTarget: "main" });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        notify: "queue changed",
        wake,
      })),
    });

    await expect(executeJobCore(state, job)).resolves.toMatchObject({
      status: "ok",
      summary: "queue changed",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("queue changed", {
      agentId: "finn",
      contextKey: "cron:script-job:script",
    });
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "cron",
      intent,
      reason: "cron:script-job:script",
      agentId: "finn",
    });
  });

  it("delivers nothing and enqueues nothing when notify and wake are absent", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
        delivered: false,
        deliveryAttempted: false,
      })),
    });

    await expect(
      executeJobCore(state, createDueScriptJob({ now, sessionTarget: "main" })),
    ).resolves.toMatchObject({ status: "ok", scriptStateChanged: true });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects nextCheck without pacing before applying state", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
        nextCheck: { delayMs: 5_000 },
      })),
    });

    await expect(executeJobCore(state, createDueScriptJob({ now }))).resolves.toEqual({
      status: "error",
      error: "cron script payload returned nextCheck, but this job has no pacing bounds",
    });
  });

  it.each([
    ["ok", { status: "ok" as const, stateChanged: true, state: { revision: 2 } }, 2, 0],
    [
      "error",
      {
        status: "error" as const,
        error: "script threw",
        stateChanged: true,
        state: { revision: 2 },
      },
      1,
      1,
    ],
  ] as const)(
    "persists script state on %s runs only",
    async (_label, outcome, revision, errors) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-07-18T12:00:00.000Z");
      const job = createDueScriptJob({ now });
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runScriptJob: vi.fn(async () => outcome),
      });

      await onTimer(state);

      const stored = await loadCronStore(storePath);
      expect(stored.jobs[0]?.state.triggerState).toEqual({ revision });
      expect(stored.jobs[0]?.state.consecutiveErrors ?? 0).toBe(errors);
    },
  );

  it("clamps a script nextCheck through the shared pacing path", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const job = createDueScriptJob({ now, pacing: { min: "15m", max: "4h" } });
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        nextCheck: { delayMs: 5 * 60_000 },
      })),
    });

    await onTimer(state);

    const stored = await loadCronStore(storePath);
    expect(stored.jobs[0]?.state.nextRunAtMs).toBe(now + 15 * 60_000);
    expect(stored.jobs[0]?.state.pacedNextRunAtMs).toBe(now + 15 * 60_000);
  });

  it("records isolated cron task runs against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "session-run-1",
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "isolated-agent-job" }),
        message: "run isolated cron",
      }),
    );
    const task = findCronTaskByBaseRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected isolated cron task ledger record");
    }
    expect(task.childSessionKey).toBe("agent:finn:cron:isolated-agent-job:run:run-1");
    expect(task.status).toBe("succeeded");
    expect(task.terminalSummary).toBe("done");
    expect(task.detail).toMatchObject({
      kind: "cron-run",
      status: "ok",
      sessionId: "session-run-1",
      durationMs: 0,
      nextRunAtMs: now + 60_000,
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
  });

  it("records current-bound cron task runs against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
    }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          ...createDueIsolatedAgentJob({ now }),
          sessionTarget: "current",
          sessionKey: "agent:finn:telegram:direct:42",
        },
      ],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const task = findCronTaskByBaseRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected current-bound cron task ledger record");
    }
    expect(task.childSessionKey).toBe("agent:finn:cron:isolated-agent-job:run:run-1");
    expect(task.status).toBe("succeeded");
  });

  it("seeds active scheduled cron task progress for status surfaces", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    let resolveRun: ((value: { status: "ok"; summary: string }) => void) | undefined;
    const runIsolatedAgentJob = vi.fn(
      () =>
        new Promise<{ status: "ok"; summary: string }>((resolve) => {
          resolveRun = resolve;
        }),
    );

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueIsolatedAgentJob({ now })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });

    const timerRun = onTimer(state);
    await vi.waitFor(() => {
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    });

    const task = findCronTaskByBaseRunId(`cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected active cron task ledger record");
    }
    expect(task.status).toBe("running");
    expect(task.progressSummary).toBe("Running automation.");
    expect(formatTaskStatusDetail(task)).toBe("Running automation.");

    resolveRun?.({ status: "ok", summary: "done" });
    await timerRun;
  });

  it("keeps scheduler progress when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const ledgerError = new Error("disk full");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
    });

    const createTaskRecordSpy = vi
      .spyOn(taskExecutor, "createRunningTaskRunCore")
      .mockImplementation(() => {
        throw ledgerError;
      });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    expect(logger.warn).toHaveBeenCalledWith(
      { jobId: "main-heartbeat-job", error: ledgerError },
      "cron: failed to create task ledger record",
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: "main",
      contextKey: "cron:main-heartbeat-job",
    });

    createTaskRecordSpy.mockRestore();
  });
});
