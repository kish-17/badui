# ADR-004: On-device first; servers are optional relays

Status: accepted · 2026-10-04

## Context

BRAKE may observe bank alerts, emails and purchase intents — some of the most
sensitive data a person has. The brief requires collecting, storing, retaining
and transmitting the minimum and preferring local processing.

## Decision

* Parsing, fusion, classification, learning and decisions run on the user's
  device by default. Personal models (user model, regret model) are local.
* Server components exist only where a source requires one (OAuth token
  custody for aggregators, webhook receipt) and should forward minimised
  payloads to the device rather than keep them.
* Cross-user learning, if ever added, must use aggregation that cannot
  reconstruct an individual's transactions (e.g. federated updates with
  differential privacy) and be opt-in.

## Consequences

* All packages are pure and portable; no package performs I/O.
* Some sources (restricted Gmail scopes, aggregator licences) need a server
  relay; their adapters still run on-device on the relayed payload.
