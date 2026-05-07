import { afterEach, describe, expect, test } from "vitest";
import { Webhook } from "svix";
import {
  DAYTONA_WEBHOOK_MAX_BODY_BYTES,
  DaytonaWebhookBodyReadError,
  prepareDaytonaWebhookVerification,
  readDaytonaWebhookRawBody,
  verifyDaytonaWebhookRequest,
} from "./lib/daytonaWebhookVerification";

const FAKE_SIGNING_SECRET = ["whsec", "ZmFrZS1zZWNyZXQtZm9yLXRlc3RzLW9ubHk="].join("_");

function makeSignedRequest(rawBody: string, overrides?: Record<string, string>) {
  const webhook = new Webhook(FAKE_SIGNING_SECRET);
  const messageId = "msg_daytona_123";
  const timestamp = new Date();
  const signature = webhook.sign(messageId, timestamp, rawBody);

  return new Request("https://example.com/api/daytona/webhook", {
    method: "POST",
    headers: {
      "svix-id": messageId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
      ...overrides,
    },
  });
}

afterEach(() => {
  delete process.env.DAYTONA_WEBHOOK_SIGNING_SECRET;
  delete process.env.DAYTONA_WEBHOOK_ORGANIZATION_ID;
});

describe("verifyDaytonaWebhookRequest", () => {
  test("accepts valid Svix-signed Daytona sandbox events", () => {
    process.env.DAYTONA_WEBHOOK_SIGNING_SECRET = FAKE_SIGNING_SECRET;
    process.env.DAYTONA_WEBHOOK_ORGANIZATION_ID = "org-123";

    const rawBody = JSON.stringify({
      event: "sandbox.state.updated",
      timestamp: "2026-04-23T12:00:00.000Z",
      id: "sandbox-123",
      organizationId: "org-123",
      oldState: "started",
      newState: "stopped",
      updatedAt: "2026-04-23T12:00:00.000Z",
    });

    const request = makeSignedRequest(rawBody);
    const result = verifyDaytonaWebhookRequest(prepareDaytonaWebhookVerification(request), rawBody);

    expect(result.verified).toBe(true);
    expect(result.event.providerDeliveryId).toBe("msg_daytona_123");
    expect(result.event.dedupeKey).toBe("msg_daytona_123");
    expect(result.event.normalizedState).toBe("stopped");
  });

  test("rejects requests with invalid Svix signatures", () => {
    process.env.DAYTONA_WEBHOOK_SIGNING_SECRET = FAKE_SIGNING_SECRET;

    const rawBody = JSON.stringify({
      event: "sandbox.created",
      timestamp: "2026-04-23T12:00:00.000Z",
      id: "sandbox-123",
      organizationId: "org-123",
      state: "started",
      createdAt: "2026-04-23T12:00:00.000Z",
    });

    expect(() =>
      verifyDaytonaWebhookRequest(
        prepareDaytonaWebhookVerification(makeSignedRequest(rawBody, { "svix-signature": "v1,not-a-real-signature" })),
        rawBody,
      ),
    ).toThrow("Invalid Daytona webhook signature");
  });

  test("rejects unexpected organization ids after signature verification", () => {
    process.env.DAYTONA_WEBHOOK_SIGNING_SECRET = FAKE_SIGNING_SECRET;
    process.env.DAYTONA_WEBHOOK_ORGANIZATION_ID = "org-expected";

    const rawBody = JSON.stringify({
      event: "sandbox.created",
      timestamp: "2026-04-23T12:00:00.000Z",
      id: "sandbox-123",
      organizationId: "org-other",
      state: "started",
      createdAt: "2026-04-23T12:00:00.000Z",
    });

    const request = makeSignedRequest(rawBody);
    expect(() => verifyDaytonaWebhookRequest(prepareDaytonaWebhookVerification(request), rawBody)).toThrow(
      "Unexpected Daytona webhook organization.",
    );
  });

  test("rejects oversized webhook bodies before verification", async () => {
    const request = new Request("https://example.com/api/daytona/webhook", {
      method: "POST",
      headers: {
        "content-length": String(DAYTONA_WEBHOOK_MAX_BODY_BYTES + 1),
      },
      body: "x",
    });

    await expect(readDaytonaWebhookRawBody(request)).rejects.toEqual(
      new DaytonaWebhookBodyReadError("Daytona webhook payload too large.", 413),
    );
  });
});
