export type DomainErrorCode =
  | "FORBIDDEN" // server-side role check failed
  | "CONFLICT" // stale version: someone else changed the record first
  | "INVARIANT" // the action would break a safety rule (merge, renumber, ...)
  | "BLOCKED" // an active hold / unresolved review blocks this transition
  | "NOT_FOUND"
  | "VALIDATION"
  | "SOURCE_OFFLINE" // the (simulated) source system is unavailable
  | "PRINTER_UNAVAILABLE"
  | "ASSISTANT_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT" // a repeated key from another requester, scope, command or payload
  | "IDEMPOTENCY_EXPIRED" // a repeated key past its retention window (never re-run)
  | "AUTH_REQUIRED"; // not in synthetic demo mode and no identity provider is configured

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: unknown;
  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const httpStatusFor: Record<DomainErrorCode, number> = {
  FORBIDDEN: 403,
  CONFLICT: 409,
  INVARIANT: 422,
  BLOCKED: 423,
  NOT_FOUND: 404,
  VALIDATION: 400,
  SOURCE_OFFLINE: 503,
  PRINTER_UNAVAILABLE: 503,
  ASSISTANT_UNAVAILABLE: 503,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_EXPIRED: 409,
  AUTH_REQUIRED: 401,
};

export function invariant(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) throw new DomainError("INVARIANT", message, details);
}

export function notFound(what: string): never {
  throw new DomainError("NOT_FOUND", `${what} was not found`);
}
