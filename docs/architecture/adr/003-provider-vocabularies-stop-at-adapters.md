# ADR-003: Provider vocabularies stop at adapters

Status: accepted · 2026-10-04

## Context

Every provider has its own taxonomy (Plaid personal_finance_category, AA
transaction modes, bank SMS templates, Android package names, FinanceKit
transaction types). If those leak into product logic, BRAKE silently becomes
"a Plaid app" or "an Indian SMS app".

## Decision

* Adapters translate provider vocabularies into neutral hints: BRAKE taxonomy
  ids (`scheme: "brake"`), ISO 18245 MCCs (`scheme: "mcc"`), plain keywords
  (`scheme: "keyword"`), and `TypeHint`s over BRAKE's transaction types.
* Rails are modelled as a generic family plus an open scheme string, so a new
  rail needs no code change.
* `@brake/intelligence` must not mention providers or branch on `adapterId` /
  `connectionId`; an architecture test enforces this.

## Consequences

* Adding a bank, aggregator or country is adapter/data work only.
* Merchant knowledge (Amazon, Swiggy, Netflix) is merchant context, not
  provider coupling, and lives in a data table.
