# ADR-002: Observations and assertions are the source of truth

Status: accepted · 2026-10-04

## Context

One purchase can produce four or more signals from independent sources, at
different times and with different reliability. Merging too early destroys
provenance and makes mistakes permanent; users must be able to disconnect a
source and have its data disappear.

## Decision

* Persist only immutable observations (extracted facts, never raw payloads)
  and user assertions.
* `TransactionCandidate`s are a deterministic, recomputable view produced by
  the fusion engine plus intelligence patches.
* User assertions are anchored to observation ids, not candidate ids, so they
  survive re-fusion after a disconnect or a merge/split.

## Consequences

* Disconnect = delete observations of that connection + recompute.
* "How did BRAKE know this?" is answerable for every field.
* The fusion engine must be deterministic and idempotent; it is tested for both.
