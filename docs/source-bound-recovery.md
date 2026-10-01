# Opt-in source-bound release recovery

Legacy `Manifest.createReleases()` retains its existing discovery and new-only
results. Recovery callers must opt in explicitly; do not interpret a created
subset or pending labels as the original component plan.

```ts
const manifest = await Manifest.fromManifest(
  github,
  'main', // semantic base branch of the original release PR
  'release-please-config.json',
  '.release-please-manifest.json',
  {releaseTargetSha: originalReleaseCommitSha}
);
const releases = await manifest.reconcileReleases();
```

The target must be a full lowercase commit SHA. Configuration and versions are
read at that commit; the first-parent version manifest determines changed,
published components. Component/package identity is frozen there through SDK
strategies while the base branch remains available for release-title parsing.
The original merged PR is selected by exact commit/base identity, not a mutable
pending label or the newest pending PR. The complete path/version/source plan is
validated before reconciliation writes. Missing, ambiguous or edited-incompatible
originals fail rather than producing an empty successful plan.

`ReconciledRelease.releaseStatus` is `created` or `existing`. Every intended
component is returned, including releases already created before a failed attempt.
Existing is not newly created. `sha` is the verified actual tag commit, not a
possibly branch-valued GitHub `target_commitish`. Lightweight and annotated tags
are supported with bounded resolution; wrong-source tags are never moved.
Tag-only partial state is reserved/verified before release creation, duplicate
races require strict readback, and provider failures are not treated as absence.
Draft/prerelease metadata must match the declared plan. Readiness is identity and
metadata readiness, not deployment/health approval; callers retain their gates.

Label finalization errors propagate. A later targeted retry can still find the
original PR after labels change. A targeted manifest rejects legacy
`createReleases()` and `createPullRequests()` entry points to avoid accidentally
returning a new-only subset or generating a release PR from historical state.

Programmatic constructor callers must supply explicit source-bound configuration,
versions and nonempty complete `releasePlanPaths`; `fromManifest` derives those
paths itself. This capability does not activate an action/product workflow,
change artifact retention or perform expiry recovery. Consumers should use a
reviewed immutable SDK revision and separately map readiness to deployment intent.
