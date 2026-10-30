const STATUS_BY_CODE: Record<string, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  not_open: 409,
  conflict: 409,
  payload_too_large: 413,
  corrupt_state: 500,
  unsupported_state: 500,
  storage_error: 500,
  internal_error: 500,
};

// A registered symbol, so errors thrown by another copy of this module (as in the
// Vite dev server, which loads canvas code separately from the kit) are still recognized.
const BRAND: unique symbol = Symbol.for('@rwoll/canvas-kit/CanvasKitError');

/**
 * An expected canvas failure with a stable code. The kit reports it to the agent
 * as a `CanvasError` and to the UI as a JSON error response.
 */
export class CanvasKitError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'CanvasKitError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 400;
    Object.defineProperty(this, BRAND, { value: true });
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== CanvasKitError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return typeof value === 'object' && value !== null && (value as { [BRAND]?: unknown })[BRAND] === true;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
