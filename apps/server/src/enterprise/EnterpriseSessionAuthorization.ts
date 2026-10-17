import type { AuthSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Sessions from "../persistence/AuthSessions.ts";

/** Every Enterprise action needs the same three scopes as the RPCs that start it. */
export const ENTERPRISE_REQUIRED_SCOPES = [
  "orchestration:operate",
  "filesystem:write",
  "source-control:write",
] as const;

/**
 * Re-reads a session from the auth repository instead of trusting a cached connection: work that
 * runs later (a background tick, a stored approval) must stop once the session is revoked, expires
 * or loses a scope. A lookup failure counts as unauthorized.
 */
export const isEnterpriseSessionAuthorized = (
  sessions: Sessions.AuthSessionRepository["Service"],
  sessionId: AuthSessionId,
) =>
  Effect.gen(function* () {
    const session = yield* sessions.getById({ sessionId });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return (
      session._tag === "Some" &&
      session.value.revokedAt === null &&
      DateTime.toEpochMillis(session.value.expiresAt) > now &&
      ENTERPRISE_REQUIRED_SCOPES.every((scope) => session.value.scopes.includes(scope))
    );
  }).pipe(Effect.catch(() => Effect.succeed(false)));
