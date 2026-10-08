# services/api

REST API for the console and for institutions. Two ways to authenticate; everything except `/healthz`,
`GET /v1/assets*` and `GET /v1/public/markets` needs one of them.

## Session (SEP-10)

`POST /v1/auth/challenge`, sign the returned transaction with your Stellar key, `POST /v1/auth/token`.
You get an HS256 JWT (12h) to send as `Authorization: Bearer <jwt>`.

## Institution API keys

Create a key while signed in with a session:

```
POST /v1/api-keys   { "label": "ops" }   ->   { "keyId": "bk_…", "secret": "…" }
```

The secret is shown once. Keys can only be created, listed (`GET /v1/api-keys`) and revoked
(`DELETE /v1/api-keys/:keyId`) with a session, never with a key. To rotate, create the new key, move
traffic over, then revoke the old one.

Send these headers on every request:

| header | value |
|---|---|
| `x-api-key` | the `keyId` |
| `x-timestamp` | unix seconds; must be within 5 minutes of the server clock |
| `x-nonce` | 16-64 chars of `[A-Za-z0-9_-]`, never reused |
| `x-signature` | hex HMAC-SHA256 of the string below, keyed with the secret |

```
v1
<x-timestamp>
<x-nonce>
<HTTP METHOD in capitals>
<path and query exactly as sent, e.g. /v1/positions?party=…>
<sha256 hex of the raw request body; of the empty string when there is no body>
```

(joined with `\n`). The body is hashed as the exact bytes you send, so sign the same string you put on
the wire. A request that fails authentication gets `401`; 30 failures a minute from one address get
`429`. Each key is limited to 1,000 requests a minute.

```ts
import { createHash, createHmac, randomBytes } from "node:crypto";

function signed(method: string, path: string, body: string, keyId: string, secret: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const canonical = ["v1", timestamp, nonce, method, path, createHash("sha256").update(body).digest("hex")].join("\n");
  return {
    "x-api-key": keyId,
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": createHmac("sha256", secret).update(canonical).digest("hex"),
  };
}
```

## Webhooks

`POST /v1/webhooks/subscriptions { "url": "https://…", "events": ["margin.call_issued"] }` returns a
signing secret once. `GET /v1/webhooks/events` lists the events that can be subscribed to. Each
delivery is a POST with:

- `x-ballast-event`, `x-ballast-delivery`
- `x-ballast-signature: t=<unix>,v1=<hex>` where `v1` is the HMAC-SHA256 of `<t>.<raw body>` under your
  secret. Recompute it, compare in constant time, and reject if `t` is more than 5 minutes old.

A non-2xx answer is retried after 30s, 2m, 10m, 1h and 6h. After the sixth failed attempt the delivery is
dead-lettered; see it under `GET /v1/webhooks/subscriptions/:id/deliveries` and requeue it with
`POST /v1/webhooks/deliveries/:id/redeliver`. Delivery is at least once, so dedupe on
`x-ballast-delivery`. Redirects are not followed, and URLs that resolve to private addresses are refused.
