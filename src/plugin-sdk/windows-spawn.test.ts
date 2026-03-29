import { describe, expect, it } from "vitest";
import {
  applyWindowsSpawnProgramPolicy,
  resolveWindowsSpawnProgramCandidate,
  type WindowsSpawnProgramCandidate,
} from "./windows-spawn.js";

describe("applyWindowsSpawnProgramPolicy", () => {
  describe("shell-fallback quoting", () => {
    it("quotes command path with spaces when falling back to shell", () => {
      const candidate: WindowsSpawnProgramCandidate = {
        command: "C:\\Users\\Bipul Nandi\\AppData\\Roaming\\npm\\acpx.cmd",
        leadingArgv: [],
        resolution: "unresolved-wrapper",
      };
      const result = applyWindowsSpawnProgramPolicy({
        candidate,
        allowShellFallback: true,
      });
      expect(result.command).toBe('"C:\\Users\\Bipul Nandi\\AppData\\Roaming\\npm\\acpx.cmd"');
      expect(result.resolution).toBe("shell-fallback");
      expect(result.shell).toBe(true);
    });

    it("does not quote command path without spaces", () => {
      const candidate: WindowsSpawnProgramCandidate = {
        command: "C:\\Tools\\acpx.cmd",
        leadingArgv: [],
        resolution: "unresolved-wrapper",
      };
      const result = applyWindowsSpawnProgramPolicy({
        candidate,
        allowShellFallback: true,
      });
      expect(result.command).toBe("C:\\Tools\\acpx.cmd");
      expect(result.resolution).toBe("shell-fallback");
      expect(result.shell).toBe(true);
    });

    it("does not modify non-wrapper resolutions", () => {
      const candidate: WindowsSpawnProgramCandidate = {
        command: "C:\\Program Files\\node.exe",
        leadingArgv: ["script.js"],
        resolution: "node-entrypoint",
        windowsHide: true,
      };
      const result = applyWindowsSpawnProgramPolicy({
        candidate,
        allowShellFallback: true,
      });
      // Non-wrapper resolutions pass through unchanged (no quoting needed since shell=false)
      expect(result.command).toBe("C:\\Program Files\\node.exe");
      expect(result.resolution).toBe("node-entrypoint");
      expect(result.shell).toBeUndefined();
    });

    it("throws when shell fallback is disallowed for unresolved wrapper", () => {
      const candidate: WindowsSpawnProgramCandidate = {
        command: "C:\\Users\\Bipul Nandi\\acpx.cmd",
        leadingArgv: [],
        resolution: "unresolved-wrapper",
      };
      expect(() =>
        applyWindowsSpawnProgramPolicy({
          candidate,
          allowShellFallback: false,
        }),
      ).toThrow(/wrapper resolved, but no executable\/Node entrypoint/);
    });
  });
});

describe("resolveWindowsSpawnProgramCandidate", () => {
  it("returns direct resolution for non-Windows platforms", () => {
    const result = resolveWindowsSpawnProgramCandidate({
      command: "/usr/bin/acpx",
      platform: "linux",
    });
    expect(result.resolution).toBe("direct");
    expect(result.command).toBe("/usr/bin/acpx");
  });
});
