# ADR-001: TypeScript core with a JSON envelope boundary to native capture

Status: accepted · 2026-10-04

## Context

BRAKE must run across Android, iOS, browsers (extensions) and optionally a
server, and must prefer on-device processing. Capture is inherently
platform-native: `NotificationListenerService` and SMS receivers are Kotlin,
FinanceKit / App Intents / Screen Time extensions are Swift, browser
extensions are JavaScript, webhook receivers run on servers.

## Decision

* The shared logic (observation model, fusion, privacy runtime, intelligence,
  capability resolution, adapters) is dependency-free, I/O-free TypeScript.
  It runs in React Native (Hermes/JSC), browser extensions, web and Node.
* Native capture code talks to it through one JSON envelope,
  `RawSignal<P> = { adapterId, connectionId, receivedAt, payload }`, and
  receives `BrakeEvent`s back. Payload shapes are documented per adapter.
* Every public type is plain data (no classes, no branded types) so the same
  contract can be mirrored in Kotlin/Swift or validated with JSON Schema.

## Consequences

* A future port of the core (e.g. Kotlin Multiplatform or Rust) only has to
  honour the envelope and the observation schema.
* iOS extensions with tight memory limits (Screen Time shield, message filter)
  should forward minimal payloads to the main app rather than run the core.
