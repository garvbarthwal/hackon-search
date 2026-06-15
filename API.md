# SmartCart API — v5.0.0

Stateless cart-generation engine. SmartCart converts a structured `{query, parameters}` request into a deterministic cart over a Requirement Graph. **It never asks questions and never holds conversation state** — gathering user intent is the caller's job.

```
Query + Parameters → Classifier → Planner → Requirement Graph
                  → Resolver → Ranker → Coverage → Auditor → Cart
```

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

Every cart-bearing endpoint returns the same envelope (see [§5](#5-response-contract)) so clients only need one parser.

---

## 2. Quick start

```bash
docker compose up -d
npm run dev

# Bare query
curl -X POST http://localhost:3000/v1/cart/plan \
  -H 'Content-Type: application/json' \
  -d '{"query": "Pav Bhaji"}'

# With parameters — a frontend that already collected context
curl -X POST http://localhost:3000/v1/cart/plan \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "movie night snacks",
    "parameters": { "people": 5, "tastePreference": ["sweet", "savory"] }
  }'
```

---

## 3. Authentication

The server reads `SMARTCART_API_KEY` from its environment.

**Enable auth:** set `SMARTCART_API_KEY=…` in `.env`, restart. Boot log says `[server] Auth: enabled (Bearer)`.
**Disable (dev convenience):** leave `SMARTCART_API_KEY` unset.

When enabled, every `/v1/cart/*` call needs:
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
```json
{ "status": "ok", "version": "5.0.0", "uptimeSec": 612, "llmProvider": "bedrock" }
```

### `POST /v1/cart/plan`
Generate a cart. Stateless — every request is independent.

**Request:**
```json
{
  "query": "string, required",
  "parameters": { /* optional, see §6 */ }
}
```

**Response:** `CartResponse` (see [§5](#5-response-contract)).

**Query options:**
- `?debug=1` (or header `X-Debug: 1`) — include the full pipeline trace under `debug` (classifier confidence, resolver paths, constraint trace, auditor verdict, planner notes).

### `GET /v1/cart/status/:requestId`
Replays a stored response by its `requestId`. Useful for reconciliation, debugging, or async workflows.

```bash
curl http://localhost:3000/v1/cart/status/3c2ae817-34ee-4aa5-bcb4-d70e1c69d951 \
  -H 'Authorization: Bearer your-secret-key-here'
```

Served from Redis (24h) or Postgres (permanent).

### `GET /v1/docs`
Swagger UI.

---

## 5. Response contract

Every successful endpoint returns this exact shape. Fields will only ever be **added** without a major version bump.

```json
{
  "requestId": "uuid",
  "status": "success | partial_success | failed",
  "queryType": "product | brand | ingredient | dish | mission | festival | category | unknown",
  "coverage": 1.0,
  "parameters": { "people": 5 },

  "requirements": {
    "essentials":  [{ "name": "Pav",    "type": "name", "priority": "required",   "quantity": "for 5 people" }],
    "recommended": [{ "name": "Lemon",  "type": "name", "priority": "recommended" }],
    "premium":     [{ "name": "Cheese", "type": "name", "priority": "optional"    }]
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
  "debug": { "...": "only present when ?debug=1 or X-Debug:1" }
}
```

**Status meanings:**

| `status` | When you get it |
|---|---|
| `success` | Cart fully satisfies required essentials (coverage ≥ 0.9) |
| `partial_success` | Some essentials unfulfilled, but the cart has at least one item |
| `failed` | Pipeline produced no usable cart |

The response never contains `questions`, `reply`, or `clarification_required` — clarification is the caller's responsibility.

---

## 6. Parameters

`parameters` is a free-form JSON object. It carries any context the frontend has already collected from the user. The planner reads what it needs and ignores the rest. **Parameters always override the planner's defaults** — pass `people: 8` and the planner scales quantities for 8.

### Common keys the planner respects

| Key | Type | Effect |
|---|---|---|
| `people` / `guestCount` / `servings` | number | Scales `quantity` on every essential and recommended |
| `tastePreference` | string[] | Biases requirements (e.g. `["sweet","savory"]`) |
| `spiceLevel` | "mild" \| "medium" \| "hot" | Narrows the candidate space |
| `vegetarian` / `vegan` / `glutenFree` / `dairyFree` / `organic` | boolean | Diet filter |
| `highProtein` / `lowSugar` | boolean | Nutrition bias |
| `budget` | number | Tightens the requirement list, suppresses premium |
| `babyAgeMonths` / `ageGroup` | number / string | Age-appropriate variants |
| `includeX` / `excludeX` | boolean | Add or omit a requirement family |

Unknown keys are tolerated — the planner uses them in spirit (as hints/filters).

### Examples

```jsonc
// Movie night, scaled for 5
{
  "query": "movie night snacks",
  "parameters": { "people": 5, "tastePreference": ["sweet", "savory"] }
}

// Tea party for 10 with extras
{
  "query": "tea party",
  "parameters": { "guestCount": 10, "includeCake": true, "includeCookies": true }
}

// Baby care, age-aware
{
  "query": "baby care products",
  "parameters": { "babyAgeMonths": 8, "includeFood": true, "includeDiapers": true }
}

// Pav bhaji, spice-aware, scaled
{
  "query": "pav bhaji",
  "parameters": { "servings": 6, "spiceLevel": "medium" }
}

// Diet-constrained breakfast
{
  "query": "healthy breakfast",
  "parameters": { "people": 4, "budget": 500, "vegetarian": true, "highProtein": true, "lowSugar": true }
}
```

---

## 7. Error responses

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
| 400 | `invalid_query` | `query` missing or empty |
| 400 | `invalid_parameters` | `parameters` is not a JSON object |
| 400 | `invalid_request_id` | Path param missing on `/status` |
| 401 | `unauthorized` | Missing or wrong bearer token |
| 404 | `not_found` | No matching `requestId` (or unknown `/v1` path) |
| 500 | `internal_error` | Unhandled server-side error; `message` carries the cause |

---

## 8. Calling from other clients

### curl
```bash
curl -X POST http://localhost:3000/v1/cart/plan \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-secret-key-here' \
  -d '{"query": "tea party", "parameters": {"guestCount": 10}}'
```

### JavaScript / Node
```js
const res = await fetch("http://localhost:3000/v1/cart/plan", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer your-secret-key-here",
  },
  body: JSON.stringify({
    query: "movie night snacks",
    parameters: { people: 5, tastePreference: ["sweet", "savory"] },
  }),
});
const data = await res.json();

if (data.status !== "failed") {
  for (const item of data.cart.essentials) {
    console.log(`${item.requirement} → ${item.name} (₹${item.price})`);
  }
}
```

### Python
```python
import requests

res = requests.post(
    "http://localhost:3000/v1/cart/plan",
    json={
        "query": "baby care products",
        "parameters": {"babyAgeMonths": 8, "includeFood": True, "includeDiapers": True},
    },
    headers={"Authorization": "Bearer your-secret-key-here"},
)
data = res.json()

if data["status"] != "failed":
    for item in data["cart"]["essentials"]:
        print(f'{item["requirement"]} → {item["name"]}  ₹{item["price"]}')
```

### Frontend pattern (any language)

The frontend collects the user's context via any LLM or form, then makes a single call:

```python
# Pseudocode for a frontend conversation layer
context = {}
context["people"] = ask_user("How many people?")
context["tastePreference"] = ask_user("Sweet, savory, or both?")

cart = requests.post(
    "http://localhost:3000/v1/cart/plan",
    json={"query": user_initial_message, "parameters": context},
).json()

render(cart)
```

SmartCart never sees the conversation — only the structured request and response.

### Browser (cross-origin)
The server has no CORS middleware today. Either proxy through your own backend or ask to enable CORS (one-line change). Server-to-server calls are unaffected.

---

## 9. Leveraging the response

### Render essentials + recommended
```js
const cart = response.cart;
[...cart.essentials, ...cart.recommended].forEach(addToUi);
cart.premiumSuggestions.forEach(offerAsUpsell);
```

### Detect partial coverage
```js
if (response.status === "partial_success") {
  const fulfilled = new Set(response.cart.essentials.map(c => c.requirement));
  const missing = response.requirements.essentials
    .filter(r => !fulfilled.has(r.name));
  showWarning(`Couldn't find: ${missing.map(m => m.name).join(", ")}`);
}
```

### Trace why a product was picked
Send `?debug=1` and inspect `response.debug.resolverSteps` — each entry reports `resolverPath` (`exact_product`, `brand`, `subcategory`, `category`, `synonym`, `embedding`, or `none`) and how many candidates each tier contributed.

### Replay & audit
Every call writes to `CartRequestLog` and to Redis under `request:{requestId}`. Use `GET /v1/cart/status/:requestId` within 24h (Redis) or indefinitely (Postgres).

---

## 10. Operational notes

- **Response cache** lives at `request:{requestId}` for 24 hours.
- **Planner cache** uses Postgres (`RequirementCache`, 30-day TTL) keyed on `(query, queryType, parameters)` — repeat requests with the same parameters skip the LLM call.
- **Logs** are one-line JSON per HTTP request:
  ```
  {"ts":"...","requestId":"...","method":"POST","path":"/v1/cart/plan","status":200,"latencyMs":1704}
  ```
  Plus a `[cart-service]` line per pipeline run with `queryType`, `coverage`, and `latency`.
- **Latency** budget: 1.5–3s per cold call; cached repeats are <100ms.

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
| Redis client | `src/lib/redis.ts` |
| Stateless pipeline (classifier → planner → resolver → …) | `src/lib/orchestrator.ts` |
| Planner prompt + parameter handling | `src/lib/planner.ts` |

---

## 12. What SmartCart is *not*

SmartCart is a pure cart-generation engine. It deliberately does **not**:

- ask clarifying questions
- maintain chat sessions or conversation state
- decide *what* to ask the user
- return follow-up prompts

Those responsibilities sit in the frontend AI layer (chatbot, voice assistant, mobile app, browser extension, agent). The frontend can use any LLM to gather information, then send the final structured `{query, parameters}` to SmartCart. The same SmartCart instance can serve a web chat, a WhatsApp bot, a voice assistant, and an agent — they all converge on the same API call.
