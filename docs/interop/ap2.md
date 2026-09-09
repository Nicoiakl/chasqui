# AP2 ↔ Nyx5

**AP2** is the Agent Payments Protocol: a way for a human to hand an agent a signed, constrained
authorization to pay, and for a merchant and a payment processor to verify that authorization
without trusting the agent. Google published it, donated it to the FIDO Alliance in April 2026,
and still operates the repository and the specification site.

This document maps AP2 against the Nyx5 chained mandate. It is written against the real JSON
Schemas in `code/sdk/schemas/ap2/` of `github.com/google-agentic-commerce/AP2`, not against a
summary of them.

**Checked against**: AP2 v0.2.0, released 2026-04-28. Last commit on `main`: 2026-04-29. Verified
2026-09-09.

## Read this before using any older mapping

AP2 v0.2 **replaced** its mandate model. If you have seen a mapping built on `IntentMandate` and
`CartMandate`, it is mapping a withdrawn version.

| Generation | Types | Status |
|---|---|---|
| v0.1 (2025-09-16) | `IntentMandate`, `CartMandate`, `PaymentMandate`; W3C PaymentRequest embedded | Legacy. Its documentation pages were deleted in v0.2 |
| v0.2 (2026-04-28) | `mandate.checkout.1`, `mandate.checkout.open.1`, `mandate.payment.1`, `mandate.payment.open.1`; SD-JWT VC | Current and normative |

The v0.1 classes still exist in `main` because the older samples import them. There is no
specification page for them any more.

## What each protocol is actually for

AP2 answers: *is this agent allowed to spend this money, on what, and did the human really say so?*
It stops at payment authorization and at producing evidence for a dispute. The specification says
so in its own words: how that evidence is used to resolve a dispute is out of scope.

Nyx5 answers a later question: *the money is authorized, so when does it actually get released, and
what happens when the delivery was a lie?* Payment is held, a deterministic check runs, and a false
claim forfeits its bond.

They meet at exactly one point, and overlap almost nowhere. That is the useful part.

## Mandate fields

Nyx5 mandate (`src/libro/contratos.js`, `ops.mandate`) against the AP2 Open Payment Mandate.

| Nyx5 | AP2 v0.2 | Verdict |
|---|---|---|
| `cap` | `payment.amount_range.max` and `payment.budget.max` | **partial** — one Nyx5 number splits into two AP2 constraints: per transaction and cumulative |
| `expires` | `exp`, plus `payment.execution_date.not_before` / `not_after` | **equivalent** |
| `scope` | `constraints[]` | **partial** — AP2 has a closed vocabulary of eight payment constraint types; Nyx5 scope is an open object |
| `grantee` | `cnf` (a JWK, EC P-256) | **partial** — AP2 names the grantee by public key, Nyx5 by `agent@domain` |
| `grantor` | `iss` of the issuing SD-JWT | **partial** — in AP2 this is a JWT claim about the issuer, not a field of the mandate |
| `parent` | `payment.reference.conditional_transaction_id`, and the key-binding `sd_hash` | **partial** — one hop, not a general tree |
| `state` | Open vs Closed, encoded in the `vct` string | **partial** — AP2 mandates are immutable credentials, not records with mutable state |
| `id` | none; AP2 identifies a mandate by the digest of its content | **missing there** |
| `house` | none; AP2 has no tenancy | **missing there** |
| `spent` | none | **missing there**, and see the warning below |
| `root` | none; walk the delegation chain to reconstruct it | **missing there** |
| `chain` | `delegate_payload[]` of the delegation SD-JWT | **partial** — the structure exists, an enumerable field does not |

### The `spent` warning

AP2 documents `payment.budget` as a cumulative limit across several closed mandates, but the schema
carries no counter and the specification does not name which role is authoritative for keeping it.
In Nyx5, `spent` is a field of the mandate and the ledger is authoritative. Any bridge has to pick
a bookkeeper unilaterally, and that choice interoperates with nobody.

## What AP2 has that Nyx5 does not

| AP2 | Verdict |
|---|---|
| `vct` — a versioned type discriminator on every credential | **missing here** — Nyx5 versions the envelope, not the document type |
| `checkout_jwt` / `checkout_hash` — the merchant signature over a cart | **missing here** — a Nyx5 mandate is cap-based, not cart-based |
| `payee`, `payment_amount`, `payment_instrument`, `pisp` | **missing here** by design — Nyx5 is rail-agnostic and carries no payment instrument |
| Selective disclosure (`_sd` and disclosures) | **missing here** — a Nyx5 envelope is encrypted whole or not at all |
| `risk_data` from the Trusted Surface | **missing here** |
| `payment.agent_recurrence.frequency` | **missing here** |
| The Trusted Surface role, which AP2 requires to be non-agentic | **missing here** — Nyx5 has no human consent surface |
| `checkout_receipt` / `payment_receipt` | **partial** — Nyx5 has signed receipts, but they carry contract state rather than a processor confirmation |

## What Nyx5 has that AP2 does not

| Nyx5 | Verdict |
|---|---|
| Escrow: money held until a check passes | **missing there** — grep the AP2 documentation for escrow and you get nothing |
| A deterministic verifier that releases or returns | **missing there** |
| Bonds: a false claim forfeits a deposit | **missing there** |
| Contract states (`held`, `delivered`, `released`, `refunded`, `forfeited`) | **missing there** — AP2 has one enum, `Success` or `Error` |
| Reputation as a public ledger query | **missing there** |
| Agent-to-agent delegation | **missing there**, explicitly. The specification says using AP2 to delegate a mandate from one shopping agent to another is out of the current scope |
| An address anchored in DNS | **missing there** — AP2 leaves agent identification to what it calls the Commerce Protocol layer, and uses trust lists instead |

AP2 has no decentralized identifiers at all. Searching its documentation for `did:` returns nothing.
The DNS-anchored `agent@domain` of Nyx5 sits exactly in the layer AP2 leaves deliberately empty.

## The blocking problem: Ed25519

The AP2 specification requires the merchant Checkout JWT to be signed with a non-deterministic
signature scheme, and rules out Ed25519 by name, to prevent rainbow-table attacks on the hash.
Every AP2 example uses `ES256`.

Nyx5 signs everything with Ed25519. That is not a preference we can shrug off. It means a Nyx5
identity, as it exists today, cannot produce an AP2 artifact that an AP2 verifier will accept.
Speaking AP2 requires issuing a second key, ECDSA P-256, per identity, and publishing it where a
verifier looks.

## What we claim, and what we do not

**We claim**: Nyx5 covers the part of the lifecycle that begins where AP2 stops. AP2 authorizes a
payment and produces dispute evidence. Nyx5 holds the payment, runs the check, and makes a false
claim cost the one who made it.

**We do not claim**: that Nyx5 is AP2-compatible, AP2-conformant, or an AP2 implementation. It is
none of those things today. Nothing in this repository emits or verifies an AP2 credential.

## What it would take, in order of effort

1. **An ECDSA P-256 key path.** Blocking, and small. Without it nothing else matters.
2. **SD-JWT VC serialization and the `vct` discriminators.** Emit and consume compact `kb+sd-jwt`.
3. **AP2 receipts from terminal contract states.** `settled` maps to a Success payment receipt.
   `refunded` and `forfeited` do not map: AP2 has no returned terminal, only Success or Error on
   payment processing. Information is lost going down to AP2, and the mapping has to say so.
4. **A Checkout object and its hash chaining.** AP2 binds payment to a merchant-signed cart. Nyx5
   has no cart and no line items. Without one, a valid Checkout Mandate cannot be produced at all.
5. **Selective disclosure.** Restructures how scope and counterparty lists are serialized.
6. **A Trusted Surface and per-transaction key binding.** AP2 requires a non-agentic surface that
   renders the mandate to a human and collects authentication. Proving *who the agent is* is not
   the same as proving *that a human consented on a trusted surface*, and AP2 requires the second.
7. **Recognition as an Agent Provider or credential issuer.** Not an engineering problem. AP2
   trust comes from trust lists, which today runs through the FIDO Agentic Authentication Technical
   Working Group.

Items 1 to 3 are days of work and would let Nyx5 present a mandate an AP2 verifier can read. Items
4 to 7 are the difference between reading it and being trusted, and item 7 is not ours to schedule.

## Risk worth stating

There have been zero commits on the AP2 `main` branch since 2026-04-29, the day after the donation.
This is consistent with the work having moved into FIDO working-group repositories that are not
public. It also means v0.2 could be superseded without a public signal. Anything built against it
should be built so the schema can be swapped.

## Sources

- <https://ap2-protocol.org/ap2/specification/>
- <https://ap2-protocol.org/ap2/checkout_mandate/> and `/payment_mandate/` and `/agent_authorization/`
- `github.com/google-agentic-commerce/AP2`, JSON Schemas under `code/sdk/schemas/ap2/`
- Google announcement of the FIDO Alliance donation, April 2026
