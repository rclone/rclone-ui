# Rclone UI Fork — Copy + Verify Engineering Plan

## Scope

Add a manual-only `Copy + Verify` workflow to the existing Tauri 2 React/TypeScript application. Existing `Copy` remains behaviorally compatible, including its scheduler and dry-run paths. The feature uses rclone RC APIs only: it does not vendor rclone, add a database, or implement a custom comparison engine.

## Architecture

- Extract a pure transfer planner shared by Copy and Copy + Verify. It preserves destination mapping, source de-duplication, filters, remote options, and local/remote support.
- Represent each effective source as a transfer unit containing copy and verification batch inputs. Directories verify the exact destination directory; files verify their parent directories with a literal, root-anchored filename include rule.
- Verify with asynchronous `operations/check` calls using `oneWay=true`, `missingOnDst=true`, `differ=true`, `error=true`, and `match=false`. Verification never inherits size-only, ignore-checksum, or dry-run weakening.
- Enforce strict Copy + Verify completion: the parent job is finished, the daemon `executeId` matches, the result count matches submitted inputs, and every child is error-free before verification starts.
- Persist active operations and 90-day terminal history in the existing per-host store, with immutable operation IDs, stable job groups, narrow updates, and a schema-versioned migration.
- Make the hidden main window the single writer and coordinator. UI windows submit typed start, stop, repair, and verify-again commands with request IDs and acknowledgements.
- Reconcile unfinished operations on restart using both job ID and daemon execute ID. Ambiguous, expired, incomplete, or daemon-restarted work becomes `VERIFICATION REQUIRED`; success is never inferred from absence or partial output.
- Suppress internal jobs from generic Transfers and show one combined operation card/details drawer with stage labels, report, repair, verify-again, and stop actions when valid.

## Persisted model

```ts
type CopyVerifyPhase =
  | 'submitting_copy' | 'copying' | 'submitting_verification'
  | 'verifying' | 'repairing' | 'verification_required' | 'complete'

type CopyVerifyResult =
  | 'verified' | 'verified_with_limitations' | 'copy_failed'
  | 'verification_failed' | 'cancelled' | null
```

Each operation stores its host, sources, destination, timestamps, phase/result, verification method, checked-file count, contextual missing/different/error lists, durations, job references (`jobId` plus `executeId`), transfer units, and execution options. Successful filenames and remote-option values are not persisted in reports/history.

Verification method classification is checksum when every unit reports a real hash, size-only when all report `none`, mixed when both occur, and unknown when the method is absent/unrecognized. The UI says “rclone-reported” and uses `VERIFIED WITH LIMITATIONS` for every non-full-checksum case.

## UI

- Add `/copy-verify` and toolbar/command-menu entry `Copy + Verify`.
- Parameterize Copy with a default `copy` mode and a manual-only `copy-verify` mode. The default route retains existing Cron, Dry Run, labels, help, and launch behavior.
- Show exactly `This operation may replace differing destination files.` before local-to-remote starts; do not show it for remote-to-local or remote-to-remote.
- Display combined `COPYING`, `VERIFYING`, `VERIFIED`, `VERIFIED WITH LIMITATIONS`, `VERIFICATION FAILED`, `COPY FAILED`, `REPAIRING`, and `VERIFICATION REQUIRED` states.
- Repair only missing/different files, force targeted overwrite, never delete extra destination files, and always run a complete verification again after successful repair. Read/hash errors alone never enable repair.
- Copy Report contains operation ID, timestamps, source/destination, result, method, counts, durations, job references, and complete issue sections while excluding successful filenames and options.

## Delivery phases

1. Fork/bootstrap, upstream remotes, this plan, Vitest, and test scripts.
2. Pure planner extraction and unit tests.
3. Typed rclone adapter and strict aggregation, verified against a temporary local `rclone rcd`.
4. Host-store migration, coordinator, stable groups, notifications, and recovery boundaries.
5. Copy + Verify route, command entries, mode parameterization, confirmation, collision errors, and acknowledgements.
6. Combined Transfers/history cards, details drawer, report, retention, and Verify Again.
7. Manual repair and complete recheck.
8. Restart/daemon/expiry/host-switch hardening, accessibility, redacted logging, build checks, rebase, and push.

## Acceptance

Run `npm ci`, `npm run test`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `npx biome check .`. Cover planner edge cases, collision detection, verification flags/filter preservation, strict failure handling, hash classifications, issue aggregation, repair mapping, idempotent transitions, migration/retention, report escaping, exact confirmation text, unchanged Copy behavior, and local-rclone copy/check/repair/recovery scenarios.

The feature branch is `feature/copy-verify`, based on upstream `main`. Rebase at phase boundaries and push green phases independently.
