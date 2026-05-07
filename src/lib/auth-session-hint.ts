/**
 * Synchronous predictor of "this browser was signed in last time" — used by
 * `LandingRoute` to suppress a HomePage flash for returning users while
 * `useConvexAuth` is still hydrating.
 *
 * Mirrors the cookie check `@workos-inc/authkit-js` does internally before
 * attempting a session refresh (see `create-client.ts` `hasSessionCookie`):
 * the WorkOS server sets `workos-has-session` on this origin during the
 * OAuth callback and clears it on sign-out, so its presence is the same
 * signal the SDK trusts to start a refresh. We don't validate the value
 * against our clientId — single-client app on a dedicated origin — so a
 * cleared cookie (empty value) is treated as "no hint".
 */
export function hasWorkOSSessionHint(): boolean {
  if (typeof document === "undefined") return false;
  const match = document.cookie.match(/(?:^|;\s*)workos-has-session=([^;]+)/);
  return Boolean(match && match[1].length > 0);
}
