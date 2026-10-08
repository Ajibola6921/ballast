/**
 * The webhook outbox. Two steps, both safe to run repeatedly:
 *
 *  1. `fanOutRecentEvents` turns rows the other services already write (`margin_event`,
 *     `price_snapshot`) into `webhook_delivery` rows, one per matching subscription. A delivery's
 *     `(subscription, event_key)` is unique, so scanning the same window again enqueues nothing new.
 *  2. `deliverDue` POSTs every pending delivery that is due, signs it with the subscription's
 *     secret, and on failure reschedules it with backoff. After MAX_ATTEMPTS it becomes `dead`:
 *     the dead-letter queue, kept for inspection and manual redelivery instead of being dropped.
 */
import { and, eq, lte } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import type { WebhookEvent, WebhookPayload } from "@ballast/domain-types";
import { decryptSecret } from "./secretBox.js";
import { signWebhook } from "./signing.js";
import { assertSafeWebhookUrl, type ResolveAll } from "./ssrf.js";

export const MAX_ATTEMPTS = 6;
/** Delay before attempt N+1 after attempt N failed (seconds). */
export const BACKOFF_S = [30, 120, 600, 3600, 21_600];
const DELIVERY_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 50;
/** How far back a fan-out scan looks. Anything older than this when the worker was down is missed. */
const FANOUT_WINDOW_MS = 24 * 3600 * 1000;

/** Which webhook events one margin-state transition produces. */
export function eventsForMarginTransition(fromState: string, toState: string): WebhookEvent[] {
  const events: WebhookEvent[] = ["margin.state_changed"];
  if (toState === "MarginCall") events.push("margin.call_issued");
  if (fromState === "MarginCall" && (toState === "Healthy" || toState === "Warning")) {
    events.push("margin.cured");
  }
  if (toState === "Liquidation") events.push("liquidation.started");
  return events;
}

type Subscription = typeof schema.webhookSubscription.$inferSelect;

function wants(sub: Subscription, event: WebhookEvent): boolean {
  return Array.isArray(sub.events) && (sub.events as string[]).includes(event);
}

function payloadFor(event: WebhookEvent, occurredAt: Date, data: unknown): WebhookPayload {
  return { event, occurredAt: occurredAt.toISOString(), data };
}

export async function fanOutRecentEvents(db: Database, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - FANOUT_WINDOW_MS);
  const subs = (await db.select().from(schema.webhookSubscription)) as Subscription[];
  const active = subs.filter((s) => s.active);
  if (active.length === 0) return 0;

  let enqueued = 0;
  const enqueue = async (sub: Subscription, eventKey: string, event: WebhookEvent, payload: WebhookPayload) => {
    const inserted = await db
      .insert(schema.webhookDelivery)
      .values({ subscriptionId: sub.id, eventKey, event, payload, status: "pending", nextAttemptAt: now })
      .onConflictDoNothing()
      .returning({ id: schema.webhookDelivery.id });
    enqueued += inserted.length; // zero when this event was already queued by an earlier scan
  };

  const marginEvents = (await db.select().from(schema.marginEvent)).filter((e) => e.createdAt >= since);
  if (marginEvents.length > 0) {
    const lines = await db.select().from(schema.creditLine);
    const lineById = new Map(lines.map((l) => [l.id, l]));
    for (const me of marginEvents) {
      const line = lineById.get(me.creditLineId);
      if (!line) continue;
      for (const event of eventsForMarginTransition(me.fromState, me.toState)) {
        const payload = payloadFor(event, me.createdAt, {
          creditLineId: me.creditLineId,
          fromState: me.fromState,
          toState: me.toState,
          ltvBps: me.ltvBps,
        });
        for (const sub of active) {
          if (![line.lenderId, line.borrowerId].includes(sub.partyId) || !wants(sub, event)) continue;
          await enqueue(sub, `margin_event:${me.id}:${event}`, event, payload);
        }
      }
    }
  }

  const priceSubs = active.filter((s) => wants(s, "price.status_changed"));
  if (priceSubs.length > 0) {
    // Compare each snapshot with the one before it for the same asset; only a change is an event.
    const snapshots = (await db.select().from(schema.priceSnapshot)).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const previousStatus = new Map<string, string>();
    for (const snap of snapshots) {
      const before = previousStatus.get(snap.assetId);
      previousStatus.set(snap.assetId, snap.status);
      if (before === undefined || before === snap.status || snap.createdAt < since) continue;
      const payload = payloadFor("price.status_changed", snap.createdAt, {
        assetId: snap.assetId,
        fromStatus: before,
        toStatus: snap.status,
        value: snap.guardedValue,
      });
      for (const sub of priceSubs) {
        await enqueue(sub, `price_snapshot:${snap.id}`, "price.status_changed", payload);
      }
    }
  }
  return enqueued;
}

export interface DeliverOptions {
  now?: Date;
  secretKey: string;
  allowHttp?: boolean;
  fetchImpl?: typeof fetch;
  resolve?: ResolveAll;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface DeliverTally {
  delivered: number;
  retried: number;
  dead: number;
}

export async function deliverDue(db: Database, options: DeliverOptions): Promise<DeliverTally> {
  const { secretKey, allowHttp = false, fetchImpl = fetch, resolve, log = () => {} } = options;
  const now = options.now ?? new Date();
  const tally: DeliverTally = { delivered: 0, retried: 0, dead: 0 };

  const due = await db
    .select()
    .from(schema.webhookDelivery)
    .where(and(eq(schema.webhookDelivery.status, "pending"), lte(schema.webhookDelivery.nextAttemptAt, now)))
    .limit(BATCH_SIZE);

  for (const delivery of due) {
    const [sub] = await db
      .select()
      .from(schema.webhookSubscription)
      .where(eq(schema.webhookSubscription.id, delivery.subscriptionId))
      .limit(1);

    const fail = async (reason: string, permanent = false) => {
      const attempts = delivery.attempts + 1;
      const dead = permanent || attempts >= MAX_ATTEMPTS;
      await db
        .update(schema.webhookDelivery)
        .set({
          attempts,
          lastError: reason,
          status: dead ? "dead" : "pending",
          nextAttemptAt: new Date(now.getTime() + (BACKOFF_S[attempts - 1] ?? BACKOFF_S.at(-1)!) * 1000),
        })
        .where(eq(schema.webhookDelivery.id, delivery.id));
      if (dead) tally.dead++;
      else tally.retried++;
      log("webhook delivery failed", { deliveryId: delivery.id, attempts, dead, reason });
    };

    if (!sub || !sub.active) {
      await fail("subscription missing or inactive", true);
      continue;
    }

    try {
      const url = await assertSafeWebhookUrl(sub.url, { allowHttp, resolve });
      const body = JSON.stringify(delivery.payload);
      const timestampS = Math.floor(now.getTime() / 1000);
      const res = await fetchImpl(url, {
        method: "POST",
        // A redirect could bounce the request to an address the check above never saw.
        redirect: "manual",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "x-ballast-event": delivery.event,
          "x-ballast-delivery": delivery.id,
          "x-ballast-signature": signWebhook(decryptSecret(sub.secretCiphertext, secretKey), timestampS, body),
        },
        body,
      });
      if (!res.ok) {
        await fail(`subscriber responded ${res.status}`);
        continue;
      }
      await db
        .update(schema.webhookDelivery)
        .set({ status: "delivered", attempts: delivery.attempts + 1, deliveredAt: now, lastError: null })
        .where(eq(schema.webhookDelivery.id, delivery.id));
      tally.delivered++;
    } catch (err) {
      await fail(err instanceof Error ? err.message : String(err));
    }
  }
  return tally;
}
