import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = 'dsh-oauth-login'

export const name = 'pi-login-invariant'

interface InvariantLogger {
  warn?: (message: string) => void
}

function invariantLogger(ctx?: Context): InvariantLogger | undefined {
  if (ctx === undefined || !('logger' in ctx)) return undefined
  const logger = (ctx as Context & { logger?: InvariantLogger }).logger
  return typeof logger?.warn === 'function' ? logger : undefined
}

/** Record one OAuth invariant failure without the removed `ctx.invariants` service. */
export function recordOAuthInvariant(message: string, ctx?: Context): void {
  const line = `[${PACKAGE_NAME}] ${message}`
  const logger = invariantLogger(ctx)
  if (logger?.warn !== undefined) {
    logger.warn(line)
    return
  }
  console.warn(line)
}

/** Report `message` when `condition` is false. A passing check stays silent. */
export function checkOAuthInvariant(condition: boolean, message: string, ctx?: Context): void {
  if (!condition) recordOAuthInvariant(message, ctx)
}

export const apply = (ctx: Context): Promise<() => void> => {
  checkOAuthInvariant(ctx !== undefined, 'oauth invariant context is missing', ctx)
  return Promise.resolve(() => {})
}
