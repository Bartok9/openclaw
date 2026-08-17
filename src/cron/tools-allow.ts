import type { CronJob } from "./types.js";

type CronToolRuntimeSpec = Pick<CronJob, "payload" | "trigger" | "precheck">;

/** Returns whether a cron job can construct or execute OpenClaw agent tools. */
export function cronJobUsesToolRuntime(job: CronToolRuntimeSpec): boolean {
  const hasPrecheckCommand =
    typeof job.precheck?.command === "string" && job.precheck.command.trim().length > 0;
  return (
    job.payload.kind === "agentTurn" ||
    job.payload.kind === "script" ||
    Boolean(job.trigger?.script.trim()) ||
    // Host-shell precheck is an executable surface: stamp toolsAllow so capless
    // systemEvent/heartbeat/command jobs cannot inherit unrestricted undefined.
    hasPrecheckCommand
  );
}

/** Stamps an explicit unrestricted cap without changing jobs that already carry one. */
export function applyDefaultCronToolsAllow(job: CronToolRuntimeSpec): void {
  if (cronJobUsesToolRuntime(job) && job.payload.toolsAllow === undefined) {
    job.payload.toolsAllow = ["*"];
  }
}
