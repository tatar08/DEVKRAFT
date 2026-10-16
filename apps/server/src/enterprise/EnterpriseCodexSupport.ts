import type { CodexSettings } from "@t3tools/contracts";

// Profiles and native deny-read behavior are verified against this CLI version.
// Custom executable/home/arguments need their own probes before joining this MVP.
export const ENTERPRISE_CODEX_VERSION = "codex-cli 0.162.1";
export function isDefaultEnterpriseCodexConfig(config: CodexSettings): boolean {
  return (
    config.binaryPath === "codex" &&
    config.homePath === "" &&
    config.shadowHomePath === "" &&
    config.launchArgs === "" &&
    config.setupMode !== "managed"
  );
}

/** Disable startup discovery too; thread overrides arrive after native initialization. */
export const ENTERPRISE_CODEX_STARTUP_ARGS = [
  "-c",
  "features.apps=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.hooks=false",
  "-c",
  "features.multi_agent=false",
  "-c",
  "features.goals=false",
] as const;
