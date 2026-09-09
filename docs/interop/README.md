# Interoperability

Nyx5 does not compete with the payment rails. It decides *when* money is released and *what
happens* when a delivery fails, and connects to whatever moves the money.

This directory holds the mappings, each one written against the other protocol's real schema and
kept honest: where a concept has no equivalent, it says so instead of stretching a word to fit.

| Document | What it maps | Status |
|---|---|---|
| [`ap2.md`](ap2.md) | AP2 v0.2 mandates (Google, donated to the FIDO Alliance) against Nyx5 chained mandates | written, checked 2026-09-09 |
| [`x402.md`](x402.md) | The x402 v2 HTTP payment flow against Nyx5 contracts | written and implemented, checked 2026-09-09 |

## The rule these documents follow

A mapping is only useful if it can say "this does not exist on our side". Claiming
interoperability that a reader cannot reproduce is exactly the kind of free assertion this
protocol was built to make expensive.

Each row is one of:

- **equivalent** — the same thing under another name, and a reader can check it
- **partial** — close, with a difference that matters, stated in the row
- **missing here** — the other protocol has it and Nyx5 does not
- **missing there** — Nyx5 has it and the other protocol does not
