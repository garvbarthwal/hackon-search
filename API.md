# SmartCart API — v5.0.0

Conversational shopping cart planner. You send a query, the API returns a structured cart driven by deterministic retrieval over a Requirement Graph.

---

## 1. Overview

| | |
|---|---|
| **Base URL** | `http://localhost:3000` (dev) |
| **Spec version** | `5.0.0` |
| **Format** | JSON only |
| **Auth** | `Authorization: Bearer <key>` (optional in dev) |
| **Interactive docs** | `GET /v1/docs` (Swagger UI) |
| **OpenAPI JSON** | `GET /v1/openapi.json` |

Every cart-bearing endpoint returns the same envelope (see [§6](#6-response-contract)) so clients only need one parser.

---

## 2. Quick start

```bash
# Boot the stack
docker compose up -d
npm run dev

# Single-shot plan
curl -X POST http://localhost:3000/v1/cart/plan \
  -H 'Content-Type: application/json' \
  -d '{"query": "Pav Bhaji"}'
```

That returns a full `CartResponse` with essentials, recommended items, premium suggestions, and an audit verdict.

---

## 3. Authentication

The server reads `SMARTCART_API_KEY` from its environment (`.env` or shell).

**Server side — to enable auth:**
```bash
# .env
SMARTCART_API_KEY=your-secret-key-here
```
Restart the server. You'll see `[server] Auth: enabled (Bearer)` at boot.

**Server side — to disable auth (dev convenience):**
Leave `SMARTCART_API_KEY` unset. Boot log says `[server] Auth: DISABLED`. All `/v1/cart/*` calls go through without a header.

**Client side — when auth is enabled:**
Send the key in the `Authorization` header on every `/v1/cart/*` call:
```
Authorization: Bearer your-secret-key-here
```

A missing or wrong key returns:
```json
{
  "requestId": "...",
  "status": "failed",
  "error": { "code": "unauthorized", "message": "Missing or invalid API key." },
  "timestamp": "2026-06-15T07:33:44.127Z"
}
```

`/v1/health`, `/v1/docs`, and `/v1/openapi.json` never require auth.

---

## 4. Endpoints

### `GET /v1/health`
Liveness probe. No auth.

**Response:**
```json
{ "status": "ok", "version": "5.0.0", "uptimeSec": 612, "llmProvider": "bedrock" }
```

---

### `POST /v1/cart/plan`
Single-shot, stateless. Best for batch jobs, evaluation, or any caller that doesn't need conversational clarification.

**Request:**
```json
{
  "query": "Diwali decorations",
  "sessionId": "optional-uuid"
}
```

**Response:** `CartResponse` (see [§6](#6-response-contract)).

**Query options:**
- `?debug=1` or header `X-Debug: 1` — include the full pipeline trace under `debug` (classifier confidence, resolver paths, constraints, auditor verdict).

---

### `POST /v1/cart/chat`
Multi-turn. The planner may ask clarifying questions when essential info is missing (max 2 rounds).

**Request — first turn:**
```json
{ "message": "movie night" }
```

**Response if clarification needed:**
```json
{
  "requestId": "...",
  "status": "clarification_required",
  "questions": ["How many people?", "Sweet, savoury, or both?"],
  "reply": "Tell me a bit more about your movie night.",
  "sessionId": "1c2e9f7d-...-...",
  "cart": { "essentials": [], "recommended": [], "premiumSuggestions": [] },
  "...": "..."
}
```

**Request — follow-up:** include the `sessionId` you got back.
```json
{
  "sessionId": "1c2e9f7d-...-...",
  "message": "4 people, both sweet and savoury"
}
```

The session is held in Redis with a 30-minute idle TTL. On any `status: "success"` response, the session's history resets — the next message starts a new conversation under the same `sessionId`.

---

### `GET /v1/cart/status/:requestId`
Replays a stored response by its `requestId`. Useful for reconciliation, debugging, or async workflows.

```bash
curl http://localhost:3000/v1/cart/status/3c2ae817-34ee-4aa5-bcb4-d70e1c69d951 \
  -H 'Authorization: Bearer your-secret-key-here'
```

Returns the same `CartResponse` that was originally produced, served from Redis (24h) or Postgres (permanent).

---

### `GET /v1/docs`
Swagger UI. Open in a browser. Lets you try every endpoint interactively.

---

## 5. Request fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes (for `/plan`) | The user's natural-language input. |
| `message` | string | yes (for `/chat`) | Same as `query`. Both names are accepted. |
| `sessionId` | string | no | UUID. Required to continue a conversation; created server-side if omitted. |

Body must be `Content-Type: application/json`. Max payload 256KB.

---

## 6. Response contract

Every successful endpoint returns this exact shape. Fields will only ever be **added** without a major version bump.

```json
{
  "requestId": "uuid",
  "status": "success | partial_success | clarification_required | failed",
  "queryType": "product | brand | ingredient | dish | mission | festival | category | unknown",
  "coverage": 1.0,
  "questions": [],
  "reply": "Friendly chat message for the user.",

  "requirements": {
    "essentials":  [{ "name": "Pav",    "type": "name", "priority": "required" }],
    "recommended": [{ "name": "Lemon",  "type": "name", "priority": "recommended" }],
    "premium":     [{ "name": "Cheese", "type": "name", "priority": "optional" }]
  },

  "cart": {
    "essentials": [
      {
        "productId": "cmqe5...",
        "name": "Modern Special Pav 6 Pack",
        "image": "https://...",
        "price": 32,
        "quantity": "1 pack",
        "rating": 4.4,
        "reviews": 1280,
        "brand": "Modern",
        "subCategory": "Buns & Pavs",
        "requirement": "Pav",
        "resolverPath": "exact_product",
        "substituteFor": "...",
        "substituteReason": "..."
      }
    ],
    "recommended": [],
    "premiumSuggestions": []
  },

  "audit": {
    "valid": true,
    "removed": [{ "productId": "...", "reason": "off-domain" }],
    "retries": 0,
    "summary": ""
  },

  "timestamp": "2026-06-15T07:33:45.847Z",
  "sessionId": "uuid",
  "debug": { "...": "only present when ?debug=1 or X-Debug:1" }
}
```

**Status meanings:**

| `status` | When you get it | Coverage |
|---|---|---|
| `success` | Cart fully satisfies required essentials | ≥ 0.9 |
| `partial_success` | Some essentials unfulfilled or auditor flagged items | 0 < cov < 0.9 |
| `clarification_required` | Planner needs more info; `questions` is non-empty | n/a |
| `failed` | Pipeline produced no usable cart | 0 |

---

## 7. Error responses

All errors share this envelope:

```json
{
  "requestId": "...",
  "status": "failed",
  "error": { "code": "...", "message": "..." },
  "timestamp": "2026-06-15T07:33:44.127Z"
}
```

| HTTP | `error.code` | Meaning |
|---|---|---|
| 400 | `invalid_query` | `query`/`message` missing or empty |
| 400 | `invalid_request_id` | Path param missing on `/status` |
| 401 | `unauthorized` | Missing or wrong bearer token |
| 404 | `not_found` | No matching `requestId` (or unknown `/v1` path) |
| 500 | `internal_error` | Unhandled server-side error; `message` carries the cause |

---

## 8. Calling from other sites

### curl
```bash
curl -X POST http://localhost:3000/v1/cart/plan \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-secret-key-here' \
  -d '{"query": "Pav Bhaji"}'
```

### JavaScript / Node (server-side)
```js
const res = await fetch("http://localhost:3000/v1/cart/plan", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer your-secret-key-here",
  },
  body: JSON.stringify({ query: "Pav Bhaji" }),
});
const data = await res.json();

if (data.status === "success") {
  for (const item of data.cart.essentials) {
    console.log(`${item.requirement} → ${item.name} (₹${item.price})`);
  }
} else if (data.status === "clarification_required") {
  console.log("Need more info:", data.questions);
}
```

### Python
```python
import requests

res = requests.post(
    "http://localhost:3000/v1/cart/plan",
    json={"query": "Pav Bhaji"},
    headers={"Authorization": "Bearer your-secret-key-here"},
)
data = res.json()

if data["status"] == "success":
    for item in data["cart"]["essentials"]:
        print(f'{item["requirement"]} → {item["name"]}  ₹{item["price"]}')
elif data["status"] == "clarification_required":
    print("Need more info:", data["questions"])
```

### Multi-turn chat (any language)
```python
sid = None
while True:
    msg = input("you: ")
    body = {"message": msg, **({"sessionId": sid} if sid else {})}
    res = requests.post("http://localhost:3000/v1/cart/chat", json=body,
                        headers={"Authorization": "Bearer your-secret-key-here"}).json()
    sid = res.get("sessionId", sid)
    print("bot:", res["reply"])
    if res["status"] == "clarification_required":
        print("questions:", res["questions"])
        continue
    if res["status"] in ("success", "partial_success"):
        for it in res["cart"]["essentials"]:
            print(" -", it["name"], "₹"+str(it["price"]))
        break
```

### Browser (cross-origin)
Calling from a different origin in the browser will fail today — the server has no CORS middleware. Either proxy through your own backend, or ask me to enable CORS (one-line change). For server-to-server calls (the recipes above), CORS is not involved.

---

## 9. Leveraging the response

### Render essentials + recommended in your UI
```js
const cart = response.cart;
[
  ...cart.essentials,         // always show
  ...cart.recommended,        // top 2 best-fit add-ons
].forEach(item => addToUi(item));

cart.premiumSuggestions.forEach(item => offerAsUpsell(item));
```

### Surface clarification flow
```js
if (response.status === "clarification_required") {
  showQuestions(response.questions);
  // remember response.sessionId for the user's next message
}
```

### Detect partial coverage
```js
if (response.status === "partial_success") {
  const missing = response.requirements.essentials
    .filter(r => !response.cart.essentials.some(c => c.requirement === r.name));
  showWarning(`Couldn't find: ${missing.map(m => m.name).join(", ")}`);
}
```

### Trace why a product was picked
Send `?debug=1` and inspect `response.debug.resolverSteps` — each entry reports `resolverPath` (`exact_product`, `brand`, `subcategory`, `category`, `synonym`, `embedding`, or `none`) and how many candidates each tier contributed.

### Replay & audit
Every call writes to the `CartRequestLog` table and to Redis under `request:{requestId}`. Use `GET /v1/cart/status/:requestId` to fetch the original response any time within 24h (Redis) or indefinitely (Postgres).

---

## 10. Operational notes

- **Sessions** live in Redis at `session:{sessionId}` with a 30-minute idle TTL.
- **Response cache** lives at `request:{requestId}` for 24 hours.
- **Planner cache** uses Postgres (`RequirementCache`, 30-day TTL) — repeat queries skip the LLM call.
- **Logs** are one-line JSON per HTTP request:
  ```
  {"ts":"...","requestId":"...","method":"POST","path":"/v1/cart/plan","status":200,"latencyMs":1704}
  ```
  Plus a `[cart-service]` line per cart pipeline run with `queryType`, `coverage`, and `latency`.
- **Latency** budget today: 1.5–3s per cold call; cached repeats are <100ms.

---

## 11. File map (where to change behaviour)

| Concern | File |
|---|---|
| HTTP routes | `src/api/cart.controller.ts` |
| Service entry point | `src/lib/cartPlanning.service.ts` |
| Frozen response shape | `src/lib/types/cart.types.ts` |
| Internal-to-public mapping | `src/lib/responseMapper.ts` |
| Bearer auth | `src/lib/middleware/auth.ts` |
| Request ID + log line | `src/lib/middleware/requestId.ts` |
| OpenAPI spec | `src/api/openapi.ts` |
| Sessions | `src/lib/sessions.ts` |
| Redis client | `src/lib/redis.ts` |
| Pipeline (classifier → planner → resolver → ...) | `src/lib/orchestrator.ts` |
