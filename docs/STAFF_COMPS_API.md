# Staff comps API — one person's Lighting Library comps

For whoever maintains a staff tool that shows a person (Light Room). It answers
Dan's request: "pull Lighting Library comps and display them in Wicket and/or
Lightroom — so all staff can see at a glance every product a user should have
access to."

Comps are created in IES Lens (`https://lens.ies.org/admin/#comp-access`) and
stored there. This endpoint lets a staff tool read them. It is read-only: it
cannot create, change or revoke a comp.

## Request

```
GET https://lens.ies.org/api/staff/comps?email=<address>
Authorization: Bearer <STAFF_COMPS_API_SECRET>
```

Call it from the server, never from the browser: the bearer must not reach a page.

| Parameter | Meaning |
|---|---|
| `email` | The person's address. A comp is matched by email, so send every address the person has: repeat the parameter or separate with commas. Up to 10. |
| `history` | `1` to include expired and revoked comps. Without it the answer holds only what the person has now or is scheduled to get. |

## Response

```json
{
  "emails": ["student@example.edu"],
  "history": false,
  "comps": [
    {
      "grantId": 42,
      "kind": "subscription",
      "label": "COMP: Subscription",
      "email": "student@example.edu",
      "name": "Dana Ruiz",
      "standardId": null,
      "designation": null,
      "title": null,
      "startsAt": "2026-11-10",
      "expiresAt": "2026-11-16",
      "state": "active",
      "applied": true,
      "note": "TC demo",
      "grantedBy": "staff@ies.org",
      "createdAt": "2026-11-10 14:02:11"
    },
    {
      "grantId": 41,
      "kind": "document",
      "label": "COMP: ANSI/IES RP-8-25+E2 Recommended Practice: Lighting Roadway and Parking Facilities",
      "email": "student@example.edu",
      "name": "Dana Ruiz",
      "standardId": "RP-8-25+E2",
      "designation": "ANSI/IES RP-8-25+E2",
      "title": "Recommended Practice: Lighting Roadway and Parking Facilities",
      "startsAt": "2026-11-09",
      "expiresAt": "2027-02-07",
      "state": "active",
      "applied": true,
      "note": "Lighting 201, Fall 2026",
      "grantedBy": "staff@ies.org",
      "createdAt": "2026-11-09 15:00:00"
    }
  ]
}
```

One entry per line to display:

- `kind: "document"` — one entry per document. A comp of three documents comes
  back as three entries with the same `grantId`.
- `kind: "subscription"` — the "Full IES Lens + Lighting Library" comp. It opens
  every standard, so it has no document fields.
- `label` is ready to print as is.
- `startsAt` and `expiresAt` are inclusive dates (`YYYY-MM-DD`, UTC).
- `state` is `active`, `scheduled` (starts in the future), `expired` or
  `revoked`. The last two appear only with `history=1`.
- `applied: false` means the comp is recorded but has not reached the Library
  yet, so the person cannot open the document. Show it with a warning rather
  than hiding it; staff fix it in the Lens admin (Comp access → Retry).
- `note` is the staff note typed when the comp was created; `null` when empty.

Entries arrive sorted: active, then scheduled, expired, revoked; the
subscription comp first within each group, then documents by designation.

## Errors

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error":"invalid_email"}` | No `email`, or one of them is not an address. |
| 400 | `{"error":"too_many_emails","max":10}` | More than 10 addresses. |
| 401 | `{"error":"Unauthorized"}` | Missing or wrong bearer. |
| 404 | `{"error":"Not found"}` | The secret is not configured on Lens yet. |
| 500 | `{"error":"comps unavailable: …"}` | Lens could not read its database. Show "unavailable", not "no comps". |

An empty `comps` array with status 200 means the person has no comp.

## What it does not include

- Purchases (3-year leases and paid subscriptions). Those come from SureCart.
- Membership-based access (IES membership, sustaining seats, TC chairs).

## Setup (S-FX)

```
npx wrangler secret put STAFF_COMPS_API_SECRET
```

Use a new random value, not one of the existing secrets, and give the same
value to the tool that calls the endpoint. Until it is set the route answers 404.
