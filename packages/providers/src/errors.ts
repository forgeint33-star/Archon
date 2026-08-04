/**
 * Standardized error for unknown provider types.
 * Thrown by getAgentProvider() — all surfaces (CLI, server, orchestrator, workflows)
 * get the same error shape and message format.
 */
export class UnknownProviderError extends Error {
  constructor(
    public readonly requestedProvider: string,
    public readonly registeredProviders: string[]
  ) {
    super(`Unknown provider: '${requestedProvider}'. Available: ${registeredProviders.join(', ')}`);
    this.name = 'UnknownProviderError';
  }
}

/**
 * A bounded-mode request also carried an option that defeats the bound.
 *
 * Thrown BEFORE any subprocess spawns, so nothing is billed. These are refusals
 * rather than silent narrowings on purpose: dropping a caller's `resume` or
 * `fallbackModel` without saying so would leave them believing a request ran
 * under a posture it did not.
 */
export class BoundedModeViolationError extends Error {
  constructor(public readonly violations: string[]) {
    super(
      `Bounded mode refused the request — these options are incompatible with a declared bound: ${violations.join(
        '; '
      )}`
    );
    this.name = 'BoundedModeViolationError';
  }
}

/**
 * A bounded-mode request reached a provider that cannot enforce the bound.
 *
 * Running it anyway would produce an unbounded run wearing a bounded label,
 * which is worse than refusing: the caller would reserve against a ceiling
 * nothing enforces.
 */
export class BoundedModeUnsupportedError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `Provider '${providerId}' cannot enforce bounded mode (no maxTurns/maxBudgetUsd enforcement). ` +
        'Refusing rather than running unbounded under a bounded contract.'
    );
    this.name = 'BoundedModeUnsupportedError';
  }
}
