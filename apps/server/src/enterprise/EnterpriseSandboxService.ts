import { TaskSpec, EnterpriseCheck } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";

export { EnterpriseCheck };
export class EnterpriseSandboxUnavailable extends Schema.TaggedError<EnterpriseSandboxUnavailable>()(
  "EnterpriseSandboxUnavailable",
  {},
) {
  override get message(): string {
    return "Enterprise sandbox is unavailable. Linux Bubblewrap namespaces and prlimit are required; host execution is disabled.";
  }
}
export class EnterpriseCheckRejected extends Schema.TaggedError<EnterpriseCheckRejected>()(
  "EnterpriseCheckRejected",
  {
    reason: Schema.Literals(["tool_not_allowed", "check_failed", "check_timed_out"]),
  },
) {
  override get message(): string {
    return `Enterprise check rejected: ${this.reason}.`;
  }
}
export class EnterpriseSandboxError extends Schema.TaggedError<EnterpriseSandboxError>()(
  "EnterpriseSandboxError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Enterprise sandbox execution failed.";
  }
}
export class EnterpriseSandboxService extends Context.Service<
  EnterpriseSandboxService,
  {
    readonly run: (input: {
      readonly spec: TaskSpec;
      readonly worktreePath: string;
      readonly check: EnterpriseCheck;
    }) => Effect.Effect<
      ProcessRunner.ProcessRunOutput,
      EnterpriseSandboxUnavailable | EnterpriseCheckRejected | EnterpriseSandboxError
    >;
  }
>()("t3/enterprise/EnterpriseSandboxService") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const run = Effect.fn("EnterpriseSandboxService.run")(function* (input: {
    readonly spec: TaskSpec;
    readonly worktreePath: string;
    readonly check: EnterpriseCheck;
  }) {
    if (!input.spec.approvedTools.includes(input.check.tool))
      return yield* new EnterpriseCheckRejected({ reason: "tool_not_allowed" });
    if (!(yield* fs.exists("/usr/bin/bwrap")) || !(yield* fs.exists("/usr/bin/prlimit")))
      return yield* new EnterpriseSandboxUnavailable({});
    const workspace = yield* fs.realPath(input.worktreePath);
    const limits = [
      "/usr/bin/prlimit",
      "--as=2147483648",
      "--cpu=60",
      "--nproc=128",
      "--nofile=256",
      "--",
    ];
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--setenv",
      "PATH",
      "/toolchain:/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
    ];
    if (yield* fs.exists("/lib64")) args.push("--ro-bind", "/lib64", "/lib64");
    const node = yield* HostProcess.ExecutablePath;
    args.push("--dir", "/toolchain", "--ro-bind", yield* fs.realPath(node), "/toolchain/node");
    args.push(
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/sbin",
      "/sbin",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      workspace,
      "/workspace",
      "--chdir",
      "/workspace",
      "--",
    );
    const probe = yield* runner
      .run({
        command: "/usr/bin/bwrap",
        args: [...args, ...limits, "/usr/bin/true"],
        cwd: workspace,
        timeout: "5 seconds",
        maxOutputBytes: 4096,
      })
      .pipe(Effect.mapError(() => new EnterpriseSandboxUnavailable({})));
    if (probe.code !== 0) return yield* new EnterpriseSandboxUnavailable({});
    const output = yield* runner.run({
      command: "/usr/bin/bwrap",
      args: [
        ...args,
        ...limits,
        input.check.tool === "/usr/bin/node" ? "/toolchain/node" : input.check.tool,
        ...input.check.args,
      ],
      cwd: workspace,
      timeout: `${input.check.timeoutMs} millis`,
      maxOutputBytes: 1_048_576,
    });
    if (output.timedOut) return yield* new EnterpriseCheckRejected({ reason: "check_timed_out" });
    if (output.code !== 0) return yield* new EnterpriseCheckRejected({ reason: "check_failed" });
    return output;
  });
  return EnterpriseSandboxService.of({
    run: (input) =>
      run(input).pipe(
        Effect.mapError((cause) =>
          cause._tag === "EnterpriseCheckRejected" || cause._tag === "EnterpriseSandboxUnavailable"
            ? cause
            : new EnterpriseSandboxError({ cause }),
        ),
      ),
  });
});
export const layer = Layer.effect(EnterpriseSandboxService, make);
