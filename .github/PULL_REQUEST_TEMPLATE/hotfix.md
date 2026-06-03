## Hotfix Summary

<!-- One-line statement of the production issue and why this needs immediate release. -->

## Severity

- [ ] P0 - outage / data loss / unsafe behavior
- [ ] P1 - core Finn flow broken for all users
- [ ] P2 - major degraded behavior for a subset of users

## Customer / Operator Impact

<!-- What is failing in production? Who is blocked? -->

## Incident Context

<!-- Link the incident thread, alert, dashboard, or GitHub issue if one exists. -->

## Root Cause

<!-- Keep this brief but concrete. -->

## Minimal Fix

<!-- Explain the smallest change made to stop the issue. -->

## Rollback Plan

- [ ] Safe to revert directly
- [ ] Requires additional steps

Rollback notes:

## Validation

- [ ] Reproduced or confirmed the failure signal before the fix
- [ ] Tested locally against the failing path
- [ ] Verified the fix in the most relevant environment available
- [ ] `bun run check` passes locally
- [ ] Relevant tests pass locally
- [ ] Monitoring / logs checked after validation

## Deployment Notes

- [ ] No migration required
- [ ] No config or env changes
- [ ] No prompt or identity restart implications

Notes:

## Checklist

- [ ] Diff is minimal and scoped to the incident
- [ ] Unrelated cleanup was intentionally excluded
- [ ] Another engineer reviewed this if one was available
- [ ] Follow-up work or postmortem items are captured elsewhere

## Related Issues

<!-- Link any related GitHub issues or follow-up tickets. -->
