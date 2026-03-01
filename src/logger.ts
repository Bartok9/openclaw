/**
 * Unified logging utilities for OpenClaw.
 *
 * This module provides consistent logging across the application with:
 * - Multiple log levels (info, warn, success, error, debug)
 * - Automatic subsystem detection from message prefixes (e.g., "discord: connected")
 * - Dual output to console (with colors) and file logger
 * - Runtime-aware logging for different execution contexts
 *
 * @module logger
 */
import { danger, info, logVerboseConsole, success, warn } from "./globals.js";
import { getLogger } from "./logging/logger.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

/** Pattern to detect subsystem prefix in log messages (e.g., "telegram: message received") */
const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;

/**
 * Extract subsystem name from a prefixed log message.
 *
 * @param message - Log message potentially containing a subsystem prefix
 * @returns Parsed subsystem and remaining message, or null if no prefix found
 */
function splitSubsystem(message: string): { subsystem: string; rest: string } | null {
  const match = message.match(subsystemPrefixRe);
  if (!match) {
    return null;
  }
  const [, subsystem, rest] = match;
  return { subsystem: subsystem!, rest: rest! };
}

/**
 * Log an informational message.
 *
 * @param message - Message to log (may include "subsystem: " prefix)
 * @param runtime - Runtime environment for console output
 */
export function logInfo(message: string, runtime: RuntimeEnv = defaultRuntime): void {
  const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem).info(parsed.rest);
    return;
  }
  runtime.log(info(message));
  getLogger().info(message);
}

/**
 * Log a warning message.
 *
 * @param message - Warning message to log
 * @param runtime - Runtime environment for console output
 */
export function logWarn(message: string, runtime: RuntimeEnv = defaultRuntime): void {
  const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem).warn(parsed.rest);
    return;
  }
  runtime.log(warn(message));
  getLogger().warn(message);
}

/**
 * Log a success message (displayed in green).
 *
 * @param message - Success message to log
 * @param runtime - Runtime environment for console output
 */
export function logSuccess(message: string, runtime: RuntimeEnv = defaultRuntime): void {
  const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem).info(parsed.rest);
    return;
  }
  runtime.log(success(message));
  getLogger().info(message);
}

/**
 * Log an error message.
 *
 * @param message - Error message to log
 * @param runtime - Runtime environment for console output
 */
export function logError(message: string, runtime: RuntimeEnv = defaultRuntime): void {
  const parsed = runtime === defaultRuntime ? splitSubsystem(message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem).error(parsed.rest);
    return;
  }
  runtime.error(danger(message));
  getLogger().error(message);
}

/**
 * Log a debug message.
 *
 * Debug messages are always written to the file logger (level-filtered)
 * but only appear on console when verbose mode is enabled.
 *
 * @param message - Debug message to log
 */
export function logDebug(message: string): void {
  getLogger().debug(message);
  logVerboseConsole(message);
}
