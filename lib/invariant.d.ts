import { Context } from "@deepseek-ai/cordis";

//#region src/invariant.d.ts
declare const name = "pi-login-invariant";
/** Record one OAuth invariant failure without the removed `ctx.invariants` service. */
declare function recordOAuthInvariant(message: string, ctx?: Context): void;
/** Report `message` when `condition` is false. A passing check stays silent. */
declare function checkOAuthInvariant(condition: boolean, message: string, ctx?: Context): void;
declare const apply: (ctx: Context) => Promise<() => void>;
//#endregion
export { apply, checkOAuthInvariant, name, recordOAuthInvariant };