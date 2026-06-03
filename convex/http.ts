import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import {
  DaytonaWebhookBodyReadError,
  prepareDaytonaWebhookVerification,
  readDaytonaWebhookRawBody,
  verifyDaytonaWebhookRequest,
  type NormalizedDaytonaWebhookEvent,
  type DaytonaWebhookVerificationContext,
} from "./lib/daytonaWebhookVerification";
import { createOpaqueErrorId, logErrorWithId, logInfo, logWarn } from "./lib/observability";
import { normalizeReturnToUrl } from "./lib/returnTo";

const http = httpRouter();
const GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

class GitHubWebhookBodyReadError extends Error {
  constructor(
    message: "GitHub webhook payload too large." | "Invalid GitHub webhook content length.",
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = "GitHubWebhookBodyReadError";
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function buildRedirectUrl(baseUrl: string, params: Record<string, string>): string {
  const redirectUrl = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    redirectUrl.searchParams.set(key, value);
  }
  return redirectUrl.toString();
}

function parseGitHubInstallationId(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value)) {
    return null;
  }

  const installationId = Number(value);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return null;
  }

  return installationId;
}

function getGitHubAppClientId(): string {
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("GITHUB_APP_CLIENT_ID is required. Set it in your Convex dashboard environment variables.");
  }
  return clientId;
}

function getCurrentCallbackUri(url: URL): string {
  const callbackUri = new URL(url.toString());
  callbackUri.search = "";
  callbackUri.hash = "";
  return callbackUri.toString();
}

function buildGitHubUserAuthorizationUrl(args: {
  clientId: string;
  state: string;
  redirectUri: string;
  codeChallenge: string;
}): string {
  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", args.clientId);
  authorizationUrl.searchParams.set("state", args.state);
  authorizationUrl.searchParams.set("redirect_uri", args.redirectUri);
  authorizationUrl.searchParams.set("code_challenge", args.codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return authorizationUrl.toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readGitHubWebhookRawBody(request: Request, maxBytes = GITHUB_WEBHOOK_MAX_BODY_BYTES): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedContentLength = Number(contentLength);
    if (!Number.isInteger(parsedContentLength) || parsedContentLength < 0) {
      throw new GitHubWebhookBodyReadError("Invalid GitHub webhook content length.", 400);
    }
    if (parsedContentLength > maxBytes) {
      throw new GitHubWebhookBodyReadError("GitHub webhook payload too large.", 413);
    }
  }

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let rawBody = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("GitHub webhook payload too large.");
        throw new GitHubWebhookBodyReadError("GitHub webhook payload too large.", 413);
      }

      rawBody += decoder.decode(value, { stream: true });
    }

    rawBody += decoder.decode();
    return rawBody;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Renders the post-callback page shown after GitHub redirects back to us.
 *
 * The install / permissions flow can run in two browser contexts:
 *   1. A popup opened by the dialog (`window.open(...)` in
 *      `ImportRepoDialog#handleConnectGitHub`).
 *   2. A full-page redirect when the popup was blocked.
 * GitHub's redirect URL is the same for both, so the server can't tell them
 * apart. The page renders the fallback content unconditionally and lets an
 * inline script enhance behaviour:
 *
 *   popup + success/auto-close → `window.close()` (with the fallback as a
 *      script-blocked degradation: "you can close this tab")
 *   popup + error              → keep fallback visible so the user reads the
 *      error before manually closing; the opener's `popup.closed` polling in
 *      `ImportRepoDialog` resets `isAwaitingPopup` once they do
 *   full-page + redirect       → `window.location.replace(redirect)`
 *   full-page + no redirect    → keep fallback visible (e.g. the
 *      permissions-update flow with no stored returnTo)
 *
 * The fallback is rendered visible by default — if scripts are blocked the
 * user still sees a readable page rather than a blank one.
 *
 * `window.close()` is synchronous: when the browser honours it, the script
 * context is destroyed at task end so anything after the `close()` call is a
 * no-op; when blocked it returns immediately and we re-show the fallback.
 * No `setTimeout` padding is needed.
 */
function renderCallbackPage(opts: {
  status: number;
  title: string;
  message: string;
  redirectTarget: string | null;
  redirectParams: Record<string, string>;
  isError: boolean;
}): Response {
  let finalRedirect: string | null = null;
  if (opts.redirectTarget) {
    try {
      finalRedirect = buildRedirectUrl(normalizeReturnToUrl(opts.redirectTarget), opts.redirectParams);
    } catch (error) {
      logWarn("http", "github_callback_redirect_target_rejected", {
        redirectTarget: opts.redirectTarget,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const redirectLiteral = finalRedirect ? JSON.stringify(finalRedirect) : "null";
  const isErrorLiteral = opts.isError ? "true" : "false";

  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(opts.title)}</title>
    <style>
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0b1020;
        color: #e5e7eb;
      }
      main {
        max-width: 36rem;
        padding: 2rem;
        border: 1px solid rgba(229, 231, 235, 0.16);
        border-radius: 1rem;
        background: rgba(15, 23, 42, 0.92);
        text-align: center;
      }
      h1 { margin: 0 0 0.75rem; font-size: 1.25rem; }
      p { margin: 0; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main id="fallback">
      <h1>${escapeHtml(opts.title)}</h1>
      <p>${escapeHtml(opts.message)}</p>
    </main>
    <script>
      (function () {
        var redirect = ${redirectLiteral};
        var isError = ${isErrorLiteral};
        var hasOpener = false;
        try { hasOpener = !!window.opener && window.opener !== window; } catch (_) {}
        var fallback = document.getElementById("fallback");

        if (hasOpener) {
          if (isError) {
            // Keep fallback visible — the opener has no signal for errors, so
            // the popup is the user's only feedback channel.
            return;
          }
          // Hide the fallback during the close attempt so a successful close
          // doesn't briefly flash the "you can close this tab" message.
          if (fallback) fallback.style.display = "none";
          try { window.close(); } catch (_) {}
          // Reached only when the browser blocked window.close().
          if (fallback) fallback.style.display = "";
        } else if (redirect) {
          if (fallback) fallback.style.display = "none";
          window.location.replace(redirect);
        }
      })();
    </script>
  </body>
</html>`;

  return new Response(body, {
    status: opts.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function callbackSuccess(
  redirectTarget: string | null,
  redirectParams: Record<string, string>,
  title: string,
  message: string,
): Response {
  return renderCallbackPage({
    status: 200,
    title,
    message,
    redirectTarget,
    redirectParams,
    isError: false,
  });
}

function callbackError(
  redirectTarget: string | null,
  redirectParams: Record<string, string>,
  status: number,
  title: string,
  message: string,
): Response {
  return renderCallbackPage({
    status,
    title,
    message,
    redirectTarget,
    redirectParams,
    isError: true,
  });
}

function callbackPermissionsUpdated(): Response {
  // No stored returnTo (this flow is initiated from GitHub's UI, not ours),
  // so the popup closes itself and the static message handles the
  // popup-blocked / full-page-tab cases.
  return renderCallbackPage({
    status: 200,
    title: "Permissions updated",
    message: "GitHub permissions updated. You can close this tab.",
    redirectTarget: null,
    redirectParams: {},
    isError: false,
  });
}

// ---------------------------------------------------------------------------
// GitHub App installation callback
// ---------------------------------------------------------------------------

/**
 * GitHub redirects here after a user installs (or updates) the GitHub App.
 *
 * Query params sent by GitHub:
 *   - installation_id: numeric ID of the installation
 *   - setup_action: "install" | "update" | "request"
 *   - state: the CSRF token we generated in initiateGitHubInstall
 *
 * The setup URL's installation_id is untrusted. We first validate the Systify
 * state, then require GitHub user authorization and verify that the resulting
 * user token can access the installation before saving it for this owner.
 */
http.route({
  path: "/api/github/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const installationIdParam = url.searchParams.get("installation_id");
    const installationId = parseGitHubInstallationId(installationIdParam);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const githubAuthorizationError = url.searchParams.get("error");
    let redirectTarget: string | null = state
      ? await ctx.runQuery(internal.github.getOAuthReturnToByState, { state })
      : null;

    if (githubAuthorizationError && state) {
      logWarn("http", "github_user_authorization_denied", {
        error: githubAuthorizationError,
        errorDescription: url.searchParams.get("error_description"),
      });
      return callbackError(
        redirectTarget,
        { github_error: "authorization_denied" },
        403,
        "GitHub connection could not be completed.",
        "GitHub user authorization was not completed, so Systify could not verify this installation.",
      );
    }

    if (code && state) {
      try {
        const oauthState: {
          ownerTokenIdentifier: string;
          returnTo: string | null;
          installationId: number;
          githubCodeVerifier: string | null;
        } = await ctx.runMutation(internal.github.consumeOAuthStateForInstallationVerification, {
          state,
          ...(installationId !== null ? { callbackInstallationId: installationId } : {}),
        });
        redirectTarget = oauthState.returnTo;

        const verification:
          | { kind: "verified" }
          | {
              kind: "unauthorized";
              message: string;
            } = await ctx.runAction(internal.githubAppNode.verifyInstallationAccessWithGitHubUser, {
          code,
          ...(oauthState.githubCodeVerifier ? { codeVerifier: oauthState.githubCodeVerifier } : {}),
          redirectUri: getCurrentCallbackUri(url),
          installationId: oauthState.installationId,
        });

        if (verification.kind === "unauthorized") {
          logWarn("http", "github_callback_user_installation_verification_failed", {
            installationId: oauthState.installationId,
            reason: verification.message,
          });
          return callbackError(
            redirectTarget,
            { github_error: "installation_not_authorized" },
            403,
            "GitHub connection could not be completed.",
            "The authenticated GitHub user could not verify access to this GitHub App installation.",
          );
        }

        const details: {
          accountLogin: string;
          accountType: "User" | "Organization";
          repositorySelection: "all" | "selected";
        } = await ctx.runAction(internal.githubAppNode.fetchInstallationDetails, {
          installationId: oauthState.installationId,
        });

        const saveResult:
          | { kind: "connected"; installationId: number }
          | {
              kind: "conflict";
              existingInstallationId: number;
              existingAccountLogin: string;
            } = await ctx.runMutation(internal.github.saveInstallation, {
          ownerTokenIdentifier: oauthState.ownerTokenIdentifier,
          installationId: oauthState.installationId,
          accountLogin: details.accountLogin,
          accountType: details.accountType,
          repositorySelection: details.repositorySelection,
        });

        if (saveResult.kind === "conflict") {
          logInfo("http", "github_callback_conflict", {
            installationId: oauthState.installationId,
            existingInstallationId: saveResult.existingInstallationId,
            existingAccountLogin: saveResult.existingAccountLogin,
          });
          return callbackError(
            redirectTarget,
            { github_error: "already_connected" },
            409,
            "GitHub connection could not be completed.",
            "This GitHub account is already connected to a different installation in Systify.",
          );
        }

        logInfo("http", "github_callback_completed", {
          installationId: oauthState.installationId,
        });
        return callbackSuccess(
          redirectTarget,
          { github_connected: "true" },
          "GitHub connection completed.",
          "GitHub finished the installation flow. You can close this tab and return to Systify.",
        );
      } catch (error) {
        const errorId = logErrorWithId("http", "github_callback_user_authorization_failed", error, {
          installationId: installationIdParam,
        });
        return callbackError(
          redirectTarget,
          {
            github_error: "callback_failed",
            error_id: errorId,
          },
          500,
          "GitHub connection could not be completed.",
          `GitHub callback processing failed. Reference: ${errorId}`,
        );
      }
    }

    if (!installationIdParam) {
      return callbackError(
        redirectTarget,
        { github_error: "missing_params" },
        400,
        "GitHub connection could not be completed.",
        "GitHub did not send the parameters needed to complete the installation flow.",
      );
    }

    if (installationId === null) {
      return callbackError(
        redirectTarget,
        { github_error: "invalid_installation" },
        400,
        "GitHub connection could not be completed.",
        "GitHub returned an invalid installation identifier.",
      );
    }

    // -----------------------------------------------------------------------
    // Permission-update flow (no state parameter, setup_action=update)
    //
    // When a user adjusts repository access via "Adjust GitHub App
    // Permissions" (which opens GitHub's installation settings directly),
    // GitHub redirects back with installation_id and setup_action=update
    // but WITHOUT a state parameter because the flow was not initiated
    // from our app.
    //
    // We intentionally skip any DB queries/mutations here because this
    // endpoint is unauthenticated — no CSRF state, no session cookie.
    // The frontend already auto-refreshes the repo list via a window
    // focus event + GitHub API call, so no server-side work is needed.
    // -----------------------------------------------------------------------
    const setupAction = url.searchParams.get("setup_action");
    if (!state && setupAction === "update") {
      logInfo("http", "github_callback_permissions_updated", {
        installationId,
      });
      return callbackPermissionsUpdated();
    }

    // If no state but setup_action is not "update", treat as unexpected callback
    if (!state) {
      return callbackError(
        redirectTarget,
        { github_error: "unexpected_callback" },
        400,
        "GitHub callback could not be completed.",
        "GitHub sent an unexpected callback without setup context.",
      );
    }

    // -----------------------------------------------------------------------
    // New installation flow (with CSRF state)
    // -----------------------------------------------------------------------
    try {
      // Validate the CSRF state and record the untrusted installation_id while
      // we verify it with a GitHub user access token.
      const oauthState: {
        returnTo: string | null;
        githubCodeChallenge: string;
      } = await ctx.runMutation(internal.github.prepareInstallationUserAuthorization, { state, installationId });
      redirectTarget = oauthState.returnTo;

      const authorizationUrl = buildGitHubUserAuthorizationUrl({
        clientId: getGitHubAppClientId(),
        state,
        redirectUri: getCurrentCallbackUri(url),
        codeChallenge: oauthState.githubCodeChallenge,
      });

      logInfo("http", "github_callback_user_authorization_started", {
        installationId,
      });
      return new Response(null, {
        status: 302,
        headers: {
          "cache-control": "no-store",
          "location": authorizationUrl,
        },
      });
    } catch (error) {
      const errorId = logErrorWithId("http", "github_callback_failed", error, {
        installationId: installationIdParam,
      });
      return callbackError(
        redirectTarget,
        {
          github_error: "callback_failed",
          error_id: errorId,
        },
        500,
        "GitHub connection could not be completed.",
        `GitHub callback processing failed. Reference: ${errorId}`,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// GitHub App webhook receiver
// ---------------------------------------------------------------------------

/**
 * Receives webhook events from the GitHub App. Verifies the payload signature
 * using HMAC-SHA256 (Web Crypto API), then dispatches to the appropriate handler.
 *
 * Supported events:
 *   - installation.deleted  -> marks installation as deleted
 *   - installation.suspend  -> marks installation as suspended
 *   - installation.unsuspend -> marks installation as active
 */
http.route({
  path: "/api/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logErrorWithId("webhook", "missing_webhook_secret", new Error("GITHUB_APP_WEBHOOK_SECRET is not set."));
      return new Response("Server misconfigured", { status: 500 });
    }

    const signature = request.headers.get("X-Hub-Signature-256");
    if (!signature) {
      return new Response("Missing signature", { status: 401 });
    }

    let body: string;
    try {
      body = await readGitHubWebhookRawBody(request);
    } catch (error) {
      if (error instanceof GitHubWebhookBodyReadError) {
        logWarn("webhook", "github_webhook_invalid_body", {
          error: error.message,
          status: error.status,
        });
        return new Response(error.status === 413 ? "Payload too large" : "Bad Request", {
          status: error.status,
        });
      }
      throw error;
    }

    // Verify HMAC-SHA256 signature using Web Crypto API
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const computed =
      "sha256=" + Array.from(new Uint8Array(signatureBytes), (b) => b.toString(16).padStart(2, "0")).join("");

    // Constant-time comparison to prevent timing attacks
    if (!constantTimeEqual(computed, signature)) {
      logWarn("webhook", "signature_verification_failed", {
        errorId: createOpaqueErrorId("webhook_signature"),
      });
      return new Response("Invalid signature", { status: 401 });
    }

    // Parse the event
    const event = request.headers.get("X-GitHub-Event");
    let payload: {
      action: string;
      installation?: { id: number };
    };
    try {
      payload = JSON.parse(body) as {
        action: string;
        installation?: { id: number };
      };
    } catch {
      return new Response("Invalid JSON payload", { status: 400 });
    }

    if (event === "installation" && payload.installation) {
      const installationId = payload.installation.id;

      switch (payload.action) {
        case "deleted":
          await ctx.runMutation(internal.github.markInstallationDeleted, {
            installationId,
          });
          break;
        case "suspend":
          await ctx.runMutation(internal.github.markInstallationSuspended, {
            installationId,
          });
          break;
        case "unsuspend":
          await ctx.runMutation(internal.github.markInstallationActive, {
            installationId,
          });
          break;
      }

      logInfo("webhook", "installation_event_processed", {
        event,
        action: payload.action,
        installationId,
      });
    }

    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Daytona sandbox webhook receiver
// ---------------------------------------------------------------------------

http.route({
  path: "/api/daytona/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let verificationContext: DaytonaWebhookVerificationContext;
    try {
      verificationContext = prepareDaytonaWebhookVerification(request);
    } catch (error) {
      logWarn("webhook", "daytona_webhook_signature_failed", {
        error: error instanceof Error ? error.message : "Unknown verification error",
      });
      return new Response("Unauthorized", { status: 401 });
    }

    let rawBody: string;
    try {
      rawBody = await readDaytonaWebhookRawBody(request);
    } catch (error) {
      if (error instanceof DaytonaWebhookBodyReadError) {
        logWarn("webhook", "daytona_webhook_invalid_body", {
          error: error.message,
          status: error.status,
        });
        return new Response(error.status === 413 ? "Payload too large" : "Bad Request", {
          status: error.status,
        });
      }
      throw error;
    }

    let verifiedEvent: NormalizedDaytonaWebhookEvent;
    try {
      const result = verifyDaytonaWebhookRequest(verificationContext, rawBody);
      verifiedEvent = result.event;
    } catch (error) {
      logWarn("webhook", "daytona_webhook_signature_failed", {
        error: error instanceof Error ? error.message : "Unknown verification error",
      });
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const ingestResult: { kind: "duplicate"; eventId: string } | { kind: "enqueued"; eventId: string } =
        await ctx.runMutation(internal.daytonaWebhooks.ingestValidatedEvent, verifiedEvent);

      logInfo("webhook", ingestResult.kind === "duplicate" ? "daytona_webhook_duplicate" : "daytona_webhook_received", {
        eventId: ingestResult.eventId,
        remoteId: verifiedEvent.remoteId,
        eventType: verifiedEvent.eventType,
        organizationId: verifiedEvent.organizationId,
      });

      return new Response("OK", { status: 200 });
    } catch (error) {
      const errorId = logErrorWithId("webhook", "daytona_webhook_ingest_failed", error, {
        remoteId: verifiedEvent.remoteId,
        eventType: verifiedEvent.eventType,
        organizationId: verifiedEvent.organizationId,
      });
      return new Response(`Failed to ingest webhook. Reference: ${errorId}`, { status: 500 });
    }
  }),
});

export default http;
