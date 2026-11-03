//#region src/invariant.ts
const PACKAGE_NAME = "dsh-oauth-login";
const name = "pi-login-invariant";
function invariantLogger(ctx) {
	if (ctx === void 0 || !("logger" in ctx)) return void 0;
	const logger = ctx.logger;
	return typeof logger?.warn === "function" ? logger : void 0;
}
/** Record one OAuth invariant failure without the removed `ctx.invariants` service. */
function recordOAuthInvariant(message, ctx) {
	const line = `[${PACKAGE_NAME}] ${message}`;
	const logger = invariantLogger(ctx);
	if (logger?.warn !== void 0) {
		logger.warn(line);
		return;
	}
	console.warn(line);
}
/** Report `message` when `condition` is false. A passing check stays silent. */
function checkOAuthInvariant(condition, message, ctx) {
	if (!condition) recordOAuthInvariant(message, ctx);
}
const apply = (ctx) => {
	checkOAuthInvariant(ctx !== void 0, "oauth invariant context is missing", ctx);
	return Promise.resolve(() => {});
};
//#endregion
export { apply, checkOAuthInvariant, name, recordOAuthInvariant };
