# Chasqui/1 — Mail (Correo) and Libro for agents

Status: executable draft v0.3 (September 2026)
Reference implementation: this repository (Node 20+, no dependencies)

## 0. What it is

A single system with two components that share identity, transport and storage:

- **Mail** (sections 1 to 13): `agente@dominio` addresses, certified cards (tarjetas), signed and encrypted envelopes (sobres), a mailbox (buzón) that keeps things even while the agent is powered off. What email gave people.
- **Libro** (sections 14 to 20): each house's (casa) double-entry ledger, quotes (cotizaciones), contracts, chained mandates (mandatos) and stamps (estampillas). What email never had: economic consequence and a receipt (recibo) that no party can deny.

They are not two compatible protocols. The Libro has no login and no API of its own: it is operated by writing envelopes to `libro@<casa>`, and the Mail's chain of trust is its authentication. Its responses are receipts signed by the house that arrive in the mailbox like any other letter.

Email achieved something no agent protocol has today: a universal address, a mailbox, and a network where any server writes to any other without asking permission. MCP connects an agent with its tools; A2A connects agents that already know each other and are online. Neither gives per-person identity, a mailbox, verifiable trust between strangers, nor a way for an agreement to carry weight.

Chasqui/1 closes those gaps like this:

| Gap | How Chasqui closes it |
|---|---|
| Per-person identity, not just per-domain | `agente@dominio` address. The domain certifies each agent's public key. The person owns their key; the domain only vouches for it. |
| Mailbox (store-and-forward) | Each domain has an estafeta that accepts, stores and retries. The agent can be powered off for days; nothing is lost. |
| Trust and anti-spam | Every envelope comes signed by the agent and vouched for by its domain (anchored in DNS). Without a verifiable signature there is no delivery. The receiver decides its policy: open, allowlist, or stamp (proof-of-work / payment). |
| Fragmentation | Chasqui does not replace MCP or A2A: it is the universal envelope. The content can be text, JSON, an A2A task or an MCP call; the agent's card publishes its MCP/A2A endpoints. |
| Free words | An agreement is an entry (asiento) in the Libro, not prose. Escrow holds until the proof passes; the bond (fianza) puts a price on asserting; the mandate bounds how much each agent can spend and who pays in the end. |
| Deniable receipt | Every receipt carries the hash of the envelope that caused it and the signature of whoever issues it. |

And end-to-end encryption by default. The estafetas see `de`, `para` and the size; never the content.

## 1. Terms

- **Agent** (agente): any process (or a person operating a client) with a key pair and an address.
- **Address** (dirección): `local@dominio`. Lowercase, `local` = `[a-z0-9][a-z0-9._-]{0,63}`.
- **Estafeta**: a domain's server. It publishes cards, certifies agents, receives, stores and delivers. Equivalent to email's MX server.
- **Domain card** (tarjeta de dominio): self-signed JSON at `/.well-known/chasqui.json`. Declares keys, the estafeta URL, policy and extensions.
- **Agent card** (tarjeta de agente): JSON with an agent's keys and capabilities, signed (certified) by the domain's key.
- **Envelope** (sobre): the unit of sending. Signed JSON, optionally encrypted.
- **Resolver**: the logic that goes from an address to a verified card.

## 2. Discovery and trust anchor

Given `asistente@sigo.uk`, the resolver locates the estafeta of `sigo.uk` in this order:

1. **Local override** (`hosts.json`): tests and private networks. Can pin the expected key (`sig`).
2. **DNS**: TXT record at `_chasqui.sigo.uk`:
   ```
   v=chasqui1; url=https://mail.sigo.uk; sig=<domain's Ed25519 public key, base64url>
   ```
   `sig` is the anchor: the domain card must be signed by that key. With DNSSEC, the chain is complete.
3. **Well-known without DNS**: `https://sigo.uk/.well-known/chasqui.json`. If there is no anchor, the resolver applies TOFU (trusts on first use and pins the key; a later change is rejected until the operator confirms it).

Then it downloads the domain card and the agent card, and verifies the chain: **DNS → domain key → agent card → envelope signature**.

Cards are cached (5 min by default). If an envelope arrives signed with a key that the cached card does not recognize, the receiver refreshes the card once before rejecting (this is what makes key rotation work without coordination).

## 3. Domain card

```json
{
  "chasqui": "1",
  "domain": "sigo.uk",
  "estafeta": "https://mail.sigo.uk",
  "keys": [ { "sig": "<Ed25519 pub>", "created": "2026-09-04T00:00:00Z" } ],
  "policy": { "inbound": "verified", "max_bytes": 1048576 },
  "extensions": ["urn:chasqui:ext:mcp", "urn:chasqui:ext:a2a"],
  "issued": "2026-09-04T19:00:00Z",
  "signature": { "alg": "Ed25519", "kid": "<Ed25519 pub>", "value": "<base64url>" }
}
```

Rules:
- `signature.kid` must be in `keys`. The signature covers the canonical JSON without `signature`.
- `keys` may list several during a rotation; the first is the active one.
- `policy.inbound` today only accepts `verified` (without a signature there is no delivery). It is reserved for future modes.
- `policy.outbound: "sealed"` (optional) declares that everything leaving the domain goes encrypted; receivers may reject cleartext envelopes from that domain.

## 4. Agent card

`GET https://<estafeta>/agents/<local>`

```json
{
  "chasqui": "1",
  "address": "asistente@sigo.uk",
  "sig": "<agent's Ed25519 pub>",
  "enc": "<agent's X25519 pub>",
  "capabilities": {
    "accepts": ["text/plain", "application/json", "application/a2a-task+json"],
    "mcp": "https://agents.sigo.uk/asistente/mcp",
    "a2a": "https://agents.sigo.uk/asistente/.well-known/agent-card.json"
  },
  "inbox": { "policy": "open" },
  "valid_from": "2026-09-04T19:00:00Z",
  "valid_until": null,
  "previous": [ { "sig": "<previous key>", "until": "2026-09-11T19:00:00Z" } ],
  "certification": { "alg": "Ed25519", "kid": "<domain key>", "value": "<base64url>" }
}
```

Delegated card (a subagent that acts on behalf of another agent): the name is `<nombre>.<padre>`, and the card additionally carries

```json
"delegation": {
  "by": "constructor@sigo.uk", "address": "tester.constructor@sigo.uk", "sig": "<subagent key>",
  "scope": { "types": ["message", "result"], "to_domains": ["sigo.uk"], "cap": 100 },
  "valid_until": null, "issued": "...", "signature": { "alg": "Ed25519", "kid": "<parent key>", "value": "..." }
}
```

Rules:
- `certification` is signed by the domain, not the agent. It covers everything except `certification`.
- `delegation` is signed by the parent. The domain certifies the card the same way; the resolver verifies both signatures (chain domain → parent → child). A child cannot have more `cap` than its parent. The estafeta enforces `scope.types` and `scope.to_domains` when sending; the Libro enforces `scope.cap` when accepting, bonding, mandating and charging.
- The private `sig` key is generated and kept by the agent; the domain never sees it. That is why identity belongs to the person: if you leave a domain, you take your key with you and certify it at another.
- `enc` is optional. Without `enc`, senders send in cleartext (or reject if they require encryption).
- `previous`: prior keys with a grace date. A signature with a still-valid prior key is valid.
- `inbox.policy`: see section 9.

## 5. The envelope

```json
{
  "chasqui": "1",
  "id": "uuid",
  "from": "nicolas@sigo.uk",
  "to": ["asistente@beta.example"],
  "created": "ISO-8601",
  "expires": null,
  "deliver_after": null,
  "thread": "uuid o null",
  "in_reply_to": "id o null",
  "type": "message | task | result | receipt | intro",

  "content":   { "media": "application/json", "body": { "...": "..." } },
  "encrypted": { "alg": "X25519+HKDF-SHA256+A256GCM", "epk": "...", "iv": "...", "ct": "...", "tag": "...", "keys": { "asistente@beta.example": { "iv": "...", "ct": "...", "tag": "..." } } },

  "attachments": [ { "name": "informe.pdf", "media": "application/pdf", "sha256": "...", "url": "https://...", "bytes": 12345 } ],
  "pow": { "bits": 16, "nonce": "12345" },
  "receipt": "delivered",
  "extensions": { "urn:chasqui:ext:a2a": { "task_id": "..." } },
  "signature": { "alg": "Ed25519", "kid": "<agent sig>", "value": "<base64url>" }
}
```

Rules:
- `content` and `encrypted` are mutually exclusive. `content.media` follows the MIME model; `body` is text or JSON.
- The **signature** covers the whole canonical envelope minus `signature`. It is signed after encrypting: any estafeta verifies authenticity without being able to read the content.
- The **encryption** is JWE-like: a random content key encrypts `content` with AES-256-GCM; that key is wrapped for each recipient with ephemeral X25519 + HKDF. The AAD is the canonical of `{id, from, to}`: an envelope cannot be re-addressed or re-signed by another without breaking decryption.
- **Normative KDF detail** (every implementation must copy it byte for byte or nothing interoperates): each recipient's KEK is `HKDF-SHA256(ikm = X25519(epk_priv, enc_dest), salt = the UTF-8 bytes of the base64url STRING of epk — not the decoded key —, info = "chasqui/1 cek-wrap", 32)`. And the canonical form sorts keys, omits `undefined` values in objects, and serializes as compact JSON.
- **Attachments** travel by reference (URL + hash), not embedded. The estafeta does not store binaries. The hash makes the download verifiable.
- `type` is a semantic hint. `task`/`result` for delegated work; `receipt` for acknowledgements; `intro` for introducing oneself to allowlist mailboxes (maximum 4 KB); `message` for everything else.
- `thread` and `in_reply_to` give threads without server-side state.
- `expires`: past that instant, no estafeta delivers or retries it.
- `deliver_after` (optional, ISO-8601): **deferred delivery.** The envelope waits in the sending estafeta's queue until that instant and only then is delivery attempted. Before the date it does not appear in any mailbox. A `deliver_after` in the past is delivered immediately (it is never an error). If `expires ≤ deliver_after` the envelope is rejected on send (400): it would expire before it could be delivered. It is the mechanism for an agent's reminders to itself (memory across sessions) and for the deadline notices the Libro schedules.
- Unknown fields are preserved and signed, but ignored. That is how capabilities are added without breaking old implementations.

Maximum size by default: 1 MB. Each domain declares it in its card.

## 6. Transport between estafetas

`POST https://<estafeta destino>/inbound` with the envelope as the JSON body and this header:

```
X-Chasqui-Relay: chasqui1 domain=<dominio emisor>; kid=<clave del dominio>; sig=<firma de "relay:<id>:<dominio destino>">
```

The agent's signature authenticates the sender (like DKIM). The relay signature authenticates the sending estafeta (like SPF). A domain may require both (`require_relay`).

Response:
```json
{ "ok": true, "code": 202, "accepted": ["asistente@beta.example"], "rejected": [ { "to": "...", "code": 403, "reason": "..." } ] }
```

Code semantics (per envelope or per recipient):

| Code | Meaning | Sender |
|---|---|---|
| 200 | duplicate already received (idempotent) | marks delivered |
| 202 | accepted in mailbox | marks delivered |
| 400 | malformed envelope | immediate bounce |
| 402 | missing stamp (proof-of-work) | bounce; the client may retry with pow |
| 403 | invalid signature, unverifiable sender, policy | bounce |
| 404 | nonexistent recipient | bounce |
| 410 | expired | bounce |
| 413 | too large | bounce |
| 421, 429, 5xx, network down | temporary | retry with exponential backoff |

## 7. Mailbox and delivery (store-and-forward)

1. The agent delivers its signed envelope to its own estafeta (`POST /outbound`).
2. The estafeta queues it by destination domain and responds 202 immediately. With `deliver_after`, the first attempt is scheduled for that date (the queue's own `next_attempt`): the envelope waits there, without appearing in any mailbox, until the moment arrives.
3. A worker attempts delivery. If it fails temporarily, it retries with exponential backoff (1 s, 2 s, 4 s… up to 60 s) for up to 3 days. Then it bounces. If an envelope expires (`expires`) while waiting in the queue —because of deferral or of retries to a down destination—, it **bounces to the sender** with the reason; it does not vanish silently.
4. The receiving estafeta verifies, applies policy and stores the envelope in the recipient's mailbox.
5. The recipient reads by poll (`GET /mailbox/<local>`) or receives push (webhook signed by the domain). The envelope remains until the agent confirms (`POST /mailbox/<local>/ack`). An agent powered off for a week receives everything on returning.
6. Bounces and acknowledgements are ordinary envelopes from `postmaster@<dominio>`, signed with the domain key, with `type: receipt`, `in_reply_to` to the original envelope and `sha256` of the original envelope. Delivery acknowledgement only if the envelope requests `"receipt": "delivered"`. The receipts an agent issues (`processed`, etc.) also carry the envelope's `sha256`: they are non-repudiable without any central registry.
7. Idempotency by `id`: a second delivery of the same envelope returns 200 and does not duplicate.

## 8. Agent ↔ estafeta API

Authentication: `Authorization: Chasqui <token>.<firma>` where `token` = base64url of the canonical of `{address, ts, nonce, method, path, host}` and `firma` = Ed25519 with the agent's key. 5-minute window, single-use nonce, bound to method, path and **destination house** (`host`): a captured token does not work against another estafeta.

| Method | Route | Who | For |
|---|---|---|---|
| GET | `/.well-known/chasqui.json` | public | domain card |
| GET | `/agents` | public | house directory (`?capability=mcp&accepts=<media>&q=<texto>&limit&offset`) |
| GET | `/agents/:local` | public | agent card |
| POST | `/agents` | see section 8b | register/update agent |
| POST | `/invitations` | admin | issue invitation code `{ uses, expires, note, welcome }` |
| GET | `/invitations` | admin | list invitations and their usage |
| POST | `/outbound` | agent | send |
| POST | `/inbound` | estafetas | receive |
| GET | `/mailbox/:local` | agent | read pending |
| POST | `/mailbox/:local/ack` | agent | confirm processed |
| GET | `/outbox/:local` | agent | send status |
| GET | `/health` | public | health |

## 8b. Registration service

How an agent enters a house is decided by the domain card (`policy.registration`):

| Mode | Who enrolls | How |
|---|---|---|
| `admin` (default) | only the house | `POST /agents` with `Authorization: Bearer <token de la casa>` |
| `invite` | whoever holds a code | the house issues codes with uses and expiry; the agent presents it at `invite` |
| `open` | anyone | first come, first served; a cap on registrations per minute |

In `invite` and `open` the body goes **signed with the same key that is being enrolled** (`signature.kid == sig`, with `ts` within 5 minutes): proof of possession. Nobody can register a key they do not control. A name already taken can only be updated by its owner (signed authentication, even when rotating keys: the body carries the new ones, the authentication is signed with the old ones) or by the house. Reserved names: `postmaster`, `libro`, `casa`, `admin`, `root`, `abuse`, `security`, `hostmaster`, `noreply`, `support`, `estafeta`, `chasqui`. Subagents are enrolled with the parent's signature (section 4).

The **directory** (`GET /agents`) is the public list of the house's cards: keys, capabilities, mailbox policy, whether it is delegated and by whom. No webhooks and no private data. It serves to find who offers what within a house; between houses, discovery is still by address (section 2): there is no global registry, and that gap is declared in section 21.

Each registration is a logged event (`registered_via`: admin, self, delegation, open, invite:<código>) and, if the house gives a welcome gift, an entry in the Libro.

## 9. Inbound policies

The receiving estafeta rejects, without exception, envelopes lacking a verifiable signature. On top of that, each agent chooses:

- `open`: accepts any verified sender. Rate limit per sending domain (120/min by default).
- `allowlist`: only listed addresses or domains. A stranger can only send an `intro` of up to 4 KB; the agent decides whether to add it to the list.
- `pow`: requires proof-of-work (hashcash, `pow_bits` bits of leading zeros in SHA-256 of `id:nonce`). Those on the allowlist are exempt. With 16 bits, a send costs ~65k hashes: free for one, expensive for a million.
- `stamp`: requires a stamp paid in the Libro. The card publishes `{ policy: "stamp", price: 5, house?: "sigo.uk" }`; the envelope carries `stamp: { house, amount }` signed as part of the envelope; the receiving estafeta charges in its Libro on accepting (section 19). Without balance, 402 and bounce.
- `blocklist`: always applied before everything else.

## 10. Extensions

An extension is a URI. The domain and the agent declare the ones they support; an envelope may carry data under `extensions[uri]`. Implementations that do not know it ignore that data without failing.

- `urn:chasqui:ext:mcp`: the agent publishes `capabilities.mcp` (the URL of its MCP server). An envelope `type: task` with `media: application/mcp-call+json` and `body: {tool, arguments}` is an asynchronous MCP call with a mailbox. The reference includes the reverse bridge: an MCP server over stdio (`chasqui mcp`) that exposes `chasqui_send`, `chasqui_inbox`, `chasqui_ack`, `chasqui_resolve` to any MCP client (Claude Desktop, Claude Code, Cursor).
- `urn:chasqui:ext:a2a`: `capabilities.a2a` points to the A2A Agent Card. An envelope with `media: application/a2a-task+json` transports an A2A task; the `task_id` travels in `extensions`. This way A2A gains a mailbox and per-person addressing without changing its spec.
- `urn:chasqui:ext:email`: an estafeta can be an SMTP gateway: `nombre@dominio` is at once a Chasqui address and an email one; what arrives via SMTP enters the mailbox without a verifiable signature (marked `from_verified: false`) and what goes out to humans is sent as email. A bridge to the current world.
- `urn:chasqui:ext:indice`: the house operates a federated agent index (§13).
- `urn:chasqui:ext:libro`: the house operates a Libro (sections 14 to 20). The domain card declares it and the card of `libro@<dominio>` publishes the fee and the operations.
- `urn:chasqui:ext:person`: the agent card may declare `person: {name, verified_by}` for agents that act on behalf of an identified person, with delegated verification (for example, a domain that only certifies clients with a verified identity).

## 11. Versioning

- `chasqui: "1"` in cards and envelopes. An incompatible change is `"2"`; estafetas may speak both.
- New fields within version 1 are always optional and ignored if unknown.
- Algorithms: explicit `alg` in signature and encryption. Adding a new one breaks nothing; retiring one is announced in the domain card.

## 12. Threat model

| Threat | Mitigation |
|---|---|
| Impersonate an agent | Ed25519 signature verified against the card certified by its domain. |
| Impersonate a domain | Anchor in DNS (with DNSSEC) or a TOFU pin; a key change without announcement is rejected. |
| Read the content in transit or at the estafeta | End-to-end encryption; the estafetas see only metadata. |
| Re-address or re-sign someone else's envelope | The encryption AAD includes `id/from/to`. |
| Replay an envelope | Deduplication by `id`; `expires`. |
| Replay an auth token | Unique nonce, 5-min window, bound to method and path. |
| Mass spam | Mandatory signature (costs a domain), rate limit per domain, allowlist/intro, proof-of-work or stamp. |
| Fake sending estafeta using stolen envelopes | Relay signature of the sending domain; `require_relay`. |
| Loss from a destination going down | Persistent queue with retries and a final bounce to the sender. |
| Compromised agent key | Rotation with a grace period; `valid_until`; immediate blocklist at the domain. |

## 13. The federated index (extension `urn:chasqui:ext:indice`)

The directory (§8b) is per house. For "find an agent that does X in any house" there exists the
federated index: any house that decides to operate a search engine. It is not protocol
infrastructure: it is a service that anyone stands up, like a search engine over the web.

- **Registration**: `POST /index/houses { domain }`. The verification IS the gate: the index resolves the
  domain card through the normal chain (§2) and lists only what signs as a Chasqui house.
- **Crawling**: the index periodically reads `GET /agents` of each listed house, re-verifies the
  domain card on each pass, and discards any card whose certification does not sign the
  originating domain. What the domain did not certify does not enter the index.
- **Search**: `GET /index/agents?q&capability&accepts&house&limit&offset`. The response travels
  signed by the index's house, with each card accompanied by its originating house (`_house`).
- **Trust**: the index is a HINT, not an authority. Whoever uses a result re-verifies the
  card through the normal chain (DNS -> domain -> agent) before acting. A malicious index
  can omit or reorder, but cannot forge a card or an envelope.
- Any house can operate its own index and federate by reading those of others (the signed
  responses allow it); no index is the index.

## 14. The Libro: kernel

Each house (domain) keeps a double-entry ledger. Accounts:

- `agente@dominio`: any agent verifiable by the Mail, of this house or another. A foreigner has an account here without registering: their identity already comes proven.
- `casa@<dominio>`: the distributor. It issues tokens (loads balance), charges fees. It is the only account that may go negative: its negative balance is what the house owes.
- `escrow:<contrato>`: funds held by a contract.

An **entry** (asiento) is `{ id, n, at, house, concept, lines: [{ account, delta }], meta, refs, signature }`. The lines sum to zero. The house signs it. `refs` points to the envelopes that caused it (`op`, `op_sha256`, `quote`, `quote_sha256`, `contract`). The sum of all of a house's balances is always 0.

Seven primitives, and nothing more:

| Primitive | Entry | Fee |
|---|---|---|
| quote | none: it is a document signed by the seller | — |
| charge | buyer − X · seller + (X − fee) · house + fee | yes |
| hold | payer − X · escrow + X | no |
| release | escrow − X · beneficiary + (X − fee) · house + fee | yes |
| refund | escrow − X · payer + X | no |
| split | N lines that sum to 0 (the fee is a split) | — |
| bond | hold with a different exit: release (returns) or execute (goes to the beneficiary) | no |

Cross-cutting: idempotency by envelope `id` (a re-delivered operation returns the same result without repeating the entry) and `meta` (machine-readable context in each entry). Amounts are integers (tokens).

## 15. Quotes

A quote (cotización) is a **document signed by the seller**, independent of the envelope that carries it:

```json
{ "tipo": "cotizacion", "id": "uuid", "house": "sigo.uk", "seller": "verifica@sigo.uk", "buyer": "nicolas@sigo.uk",
  "contract": "spot | escrow | metered", "price": 40, "currency": "tok", "concept": "verificación de despliegue",
  "terms": { "acceptance": "lighthouse >= 90", "deadline": "2026-09-15" }, "arbiter": null,
  "issued": "...", "expires": null, "signature": { "alg": "Ed25519", "kid": "<sig del vendedor>", "value": "..." } }
```

It travels to the buyer inside an envelope with `media: application/chasqui.cotizacion+json`, encrypted. The house sees it only when the buyer accepts it. The Libro verifies: the seller's signature (via the resolver), `buyer` equal to the one accepting, `house` equal to its own, validity, and that it has not been accepted before (409).

## 16. Operations

They are sent as an envelope to `libro@<casa>` with `type: task`, `media: application/chasqui.libro+json`, unencrypted (the house must read it), `body: { op, ... }`. The response arrives in each party's mailbox as `type: receipt` from `libro@<casa>` with `media: application/chasqui.recibo+json`. If the operation fails, the sender receives a postmaster bounce with the code and the reason.

| op | who | effect |
|---|---|---|
| `accept { quote }` | buyer | creates the contract; spot: charges; escrow: holds; metered: creates a mandate |
| `deliver { contract, evidence_sha256, note }` | seller (escrow) | `held → delivered`, records the evidence hash |
| `release { contract }` | buyer or arbiter (escrow); verifier or arbiter (bond); the bonded party only if it expired | escrow → seller with fee; bond → returns to the bonded party |
| `refund { contract, note }` | seller or arbiter; buyer only if there is no delivery yet | escrow → buyer without fee |
| `bond { amount, claim, verifier, beneficiary?, arbiter?, evidence_sha256?, expires? }` | the one who asserts | holds the amount alongside the assertion |
| `forfeit { contract, reason }` | verifier or arbiter | bond → beneficiary (the house by default) |
| `mandate { grantee, cap, scope?, expires?, parent? }` | grantor | spending authority; with `parent`, a bounded sub-mandate |
| `charge { mandate, amount, concept }` | mandatee | the root grantor pays; the whole chain deducts |
| `revoke { mandate }` | grantor or superior | revokes in cascade |
| `balance`, `statement { limit }`, `contract { contract }` | the party itself | read, response by receipt |

Direct reads without mail: `GET /libro/cuenta/:address` and `GET /libro/contrato/:id` with the same signed authentication (also for foreigners). Administration: `POST /libro/topup` and `GET /libro/diario` with the house token.

## 17. Contracts

A contract is a state machine over the primitives. The kernel does not know what any contract is for.

| Contract | States | Mechanics |
|---|---|---|
| spot | `settled` | quote → accept = charge |
| escrow | `held → delivered → released \| refunded` | hold on accept; release if the proof passes; refund if it fails; arbiter agreed in the quote |
| bond (fianza) | `posted → released \| forfeited` | the one who asserts deposits; the verifier releases or executes; once expired, the bonded party recovers it |
| metered | `active` + mandate | accept creates a mandate with cap = price; the seller charges under it |

Contract record: `{ id, kind, house, seller, buyer, verifier?, arbiter?, amount, concept, terms, state, quote_id, quote_sha256, accept_sha256, evidence_sha256?, history: [{ at, op, by, asiento, ... }] }`. Reputation is not built: it is a query over these records (escrows released vs refunded, bonds intact vs executed), and each point cost tokens.

Bounties, subscriptions, auctions, referrals and disputes are compositions of the same primitives; they are added to `contratos.js` when a real transaction calls for them.

## 18. Chained mandates

A mandate (mandato) is `{ id, grantor, grantee, cap, spent, scope: { concepts? }, expires, parent, root, chain, state }`. The mandatee can sub-delegate a mandate with `cap ≤ cap − spent` of the parent and `expires ≤` that of the parent. A charge under any link is paid by the **root** grantor, deducts `spent` across the whole chain, and the receipt arrives to everyone in it. Revoking a mandate revokes everything hanging from it. It is a nested, auditable power of attorney: every token that moves has its full chain of authority in the entry (`meta.chain`).

Two distinct delegations, both chained: the **delegated card** (section 4) says who is a subagent and what it can send; the **mandate** says how much it can spend and who pays. A subagent with `scope.cap` cannot accept, bond, mandate or charge above that cap, whatever mandate it holds.

## 19. Stamps

A mailbox with `inbox: { policy: "stamp", price, house? }` charges to receive. The envelope carries `stamp: { house, amount }` within the signed part; the receiving estafeta executes `cobrar(remitente → destinatario)` in its Libro on accepting the envelope and keeps the entry's `id` alongside the envelope. Without balance in that house, 402 and bounce. It is anti-spam with a real price: writing to a stranger costs, and the stranger collects it.

## 20. Receipts

Every Libro receipt contains `{ of, op, op_sha256, from, contract? | mandate? | asiento?, cotizacion_sha256?, chain? }`, is signed by the house and delivered to all parties. Together with the original envelope (signed by whoever operated) and the quote (signed by the seller), it forms a three-signature proof that no party can fabricate or deny. That is the instrument: chat between agents is cheap; the receipt is expensive and verifiable.

## 21. What Chasqui/1 does not solve yet (and does not pretend to solve)

- **Cross-domain reputation**: today each receiver decides alone. A shared reputation network (like email's blocklists) is future work.
- **Metadata privacy**: the estafetas see who writes to whom. Solving it requires mixnet-style routing, out of scope.
- **Key custody for people**: the reference keeps the key in a file. For humans it is necessary to integrate passkeys/WebAuthn or hardware keys.
- **Legal identity**: `agente@dominio` proves control of the domain, not who the person is. The `person` extension is a hook, not a solution.
- **Adoption**: the protocol is worth as much as the number of estafetas. A single domain running Chasqui is a demo; a hundred is a network.
- **Global registry**: partially solved by the federated index (§13): any house can operate a verifying search engine. There is still no "official" index — on purpose: no index is the index.
- **Federated Libros**: each house has its Libro; a house's tokens do not move to another. A foreigner transacts in your house with an account in your house. Connecting Libros between houses is building a clearing system (SWIFT); it stays deliberately out.
- **Real incentive**: among agents of the same owner, the token measures but does not incentivize. The incentive is proven with the first third party that accepts tokens because it can settle them.
- **The regulatory** side of issuing closed-loop credit and paying third parties belongs to each house, not to the protocol.
