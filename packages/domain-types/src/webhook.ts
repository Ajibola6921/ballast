/** The webhook event names from PRD §9, HMAC-signed and retried with backoff. */
export type WebhookEvent =
  | "price.status_changed"
  | "margin.state_changed"
  | "margin.call_issued"
  | "margin.cured"
  | "liquidation.started"
  | "liquidation.completed"
  | "exit.filled"
  | "repo.leg1_settled"
  | "repo.unwind_due"
  | "repo.defaulted";

export interface WebhookPayload<T = unknown> {
  event: WebhookEvent;
  occurredAt: string;
  data: T;
}

/**
 * The events the webhook outbox actually produces today (each is derived from rows the services
 * already write). The remaining names above are reserved: they are not offered for subscription
 * until something emits them, so a subscriber is never promised an event that cannot arrive.
 */
export const DELIVERABLE_WEBHOOK_EVENTS = [
  "price.status_changed",
  "margin.state_changed",
  "margin.call_issued",
  "margin.cured",
  "liquidation.started",
  "liquidation.completed",
  "exit.filled",
  "repo.leg1_settled",
] as const satisfies readonly WebhookEvent[];
