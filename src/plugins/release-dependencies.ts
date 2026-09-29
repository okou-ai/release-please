// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {ConfigurationError} from '../errors';
import {GitHub} from '../github';
import {
  CandidateReleasePullRequest,
  ReleasedVersions,
  RepositoryConfig,
  ReleaseDependencyRule,
} from '../manifest';
import {ManifestPlugin} from '../plugin';
import {Release} from '../release';
import {Strategy} from '../strategy';
import {Changelog} from '../updaters/changelog';
import {CompositeUpdater} from '../updaters/composite';
import {Update, Updater} from '../update';
import {Version} from '../version';
import {
  MajorVersionUpdate,
  MinorVersionUpdate,
  PatchVersionUpdate,
} from '../versioning-strategy';

export interface ReleaseDependencyContext {
  releasesByPath: Record<string, Release>;
  releasedVersions: ReleasedVersions;
  strategiesByPath: Record<string, Strategy>;
}

export interface ReleaseDependencyResolution {
  versions: Map<string, Version>;
  reasons: Map<string, string[]>;
  observedVersions: Map<string, Version>;
}

/**
 * A release dependency is a directed edge between independently versioned
 * manifest paths. A publishable source release candidate triggers a release
 * of its dependent, just as a workspace package release triggers its dependents.
 */
export class ReleaseDependencies extends ManifestPlugin {
  private readonly rules: ReleaseDependencyRule[];
  private readonly order: string[];

  constructor(
    github: GitHub,
    targetBranch: string,
    repositoryConfig: RepositoryConfig,
    rules: ReleaseDependencyRule[],
    separatePullRequests = false
  ) {
    super(github, targetBranch, repositoryConfig);
    // Related source and dependent versions must share a release PR. Otherwise
    // a dependent PR could merge first and repeatedly release before its source.
    if (separatePullRequests) {
      throw this.error(
        'release dependencies require a combined release pull request'
      );
    }
    if (!Array.isArray(rules) || rules.length === 0) {
      throw this.error('rules must be a non-empty array');
    }
    const edges = new Set<string>();
    for (const rule of rules) {
      if (
        !rule ||
        typeof rule.source !== 'string' ||
        typeof rule.dependent !== 'string' ||
        !Object.prototype.hasOwnProperty.call(repositoryConfig, rule.source) ||
        !Object.prototype.hasOwnProperty.call(repositoryConfig, rule.dependent)
      ) {
        throw this.error(
          'source and dependent must be configured manifest paths'
        );
      }
      if (
        Object.keys(rule).some(
          key => !['source', 'dependent', 'minimumBump'].includes(key)
        )
      ) {
        throw this.error(
          `unsupported release dependency rule field for ${rule.source} -> ${rule.dependent}`
        );
      }
      if (rule.source === rule.dependent) {
        throw this.error(`self-dependency: ${rule.source}`);
      }
      if (
        repositoryConfig[rule.source].separatePullRequests ||
        repositoryConfig[rule.dependent].separatePullRequests
      ) {
        throw this.error(
          `release dependency ${rule.source} -> ${rule.dependent} requires a combined release pull request`
        );
      }
      if (
        rule.minimumBump !== undefined &&
        !['patch', 'minor', 'major'].includes(rule.minimumBump)
      ) {
        throw this.error(
          `invalid minimumBump for ${rule.source} -> ${rule.dependent}`
        );
      }
      if (repositoryConfig[rule.dependent].skipGithubRelease) {
        throw this.error(
          `dependent ${rule.dependent} cannot skip its GitHub release`
        );
      }
      const edge = `${rule.source}\0${rule.dependent}`;
      if (edges.has(edge)) {
        throw this.error(
          `duplicate release dependency: ${rule.source} -> ${rule.dependent}`
        );
      }
      edges.add(edge);
    }
    this.rules = [...rules].sort(
      (a, b) =>
        (a.dependent < b.dependent ? -1 : a.dependent > b.dependent ? 1 : 0) ||
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)
    );
    this.order = this.topologicalOrder();
  }

  async resolve(
    candidates: CandidateReleasePullRequest[],
    context: ReleaseDependencyContext
  ): Promise<ReleaseDependencyResolution> {
    const pathsByComponent = new Map<string, string>();
    for (const path of Object.keys(this.repositoryConfig)) {
      const component =
        (await context.strategiesByPath[path].getComponent()) || '';
      const other = pathsByComponent.get(component);
      if (other && other !== path) {
        throw this.error(
          `ambiguous release component ${component}: ${other}, ${path}`
        );
      }
      pathsByComponent.set(component, path);
    }
    const candidateVersions = new Map<string, Version>();
    for (const candidate of candidates) {
      for (const data of candidate.pullRequest.body.releaseData) {
        const path = pathsByComponent.get(data.component || '');
        if (path && data.version) {
          const strategy = context.strategiesByPath[path];
          if (
            strategy.isPublishedVersion &&
            !strategy.isPublishedVersion(data.version)
          ) {
            continue;
          }
          const current = candidateVersions.get(path);
          if (!current || data.version.compare(current) > 0) {
            candidateVersions.set(path, data.version);
          }
        }
      }
    }

    // Keep the versions actually present in the generated PR separate from
    // the synthetic versions needed to propagate through dependency chains.
    const observedVersions = new Map(candidateVersions);
    const versions = new Map<string, Version>();
    const reasons = new Map<string, string[]>();
    for (const path of this.order) {
      for (const rule of this.rules.filter(rule => rule.dependent === path)) {
        if (!candidateVersions.has(rule.source)) {
          continue;
        }
        const previousVersion =
          context.releasedVersions[path] ??
          context.releasesByPath[path]?.tag.version;
        if (!previousVersion) {
          throw this.error(`missing previously released version for ${path}`);
        }
        const required = this.bump(
          previousVersion,
          rule.minimumBump || 'patch'
        );
        const existing = candidateVersions.get(path);
        if (
          existing &&
          context.strategiesByPath[path].isPublishedVersion &&
          !context.strategiesByPath[path].isPublishedVersion!(existing)
        ) {
          throw this.error(
            `dependent ${path} has no publishable release candidate`
          );
        }
        if (!existing || existing.compare(required) < 0) {
          candidateVersions.set(path, required);
          versions.set(path, required);
        }
        reasons.set(path, [
          ...(reasons.get(path) || []),
          `Release of \`${rule.source}\``,
        ]);
      }
    }
    return {versions, reasons, observedVersions};
  }

  /** Add traceable notes without manufacturing a conventional commit. */
  async addNotes(
    candidates: CandidateReleasePullRequest[],
    reasons: Map<string, string[]>,
    strategiesByPath: Record<string, Strategy>
  ): Promise<void> {
    for (const [path, entries] of reasons) {
      const component = (await strategiesByPath[path].getComponent()) || '';
      const note = `### Release Dependencies\n\n${entries
        .map(entry => `* ${entry}`)
        .join('\n')}`;
      const configuredChangelogPath =
        this.repositoryConfig[path].changelogPath || 'CHANGELOG.md';
      const changelogPath = configuredChangelogPath.startsWith('/')
        ? configuredChangelogPath.replace(/^\/+/, '')
        : `${path === '.' ? '' : `${path}/`}${configuredChangelogPath}`;
      for (const candidate of candidates) {
        const data = candidate.pullRequest.body.releaseData.find(
          data => (data.component || '') === component
        );
        if (!data) continue;
        if (!data.version) {
          throw this.error(`release dependency ${path} has no version`);
        }
        data.notes = `${data.notes.trim()}\n\n${note}`.trim();
        for (const update of candidate.pullRequest.updates) {
          if (update.path === changelogPath) {
            this.addChangelogNote(update, note, data.version);
          }
        }
      }
    }
  }

  private addChangelogNote(
    update: Update,
    note: string,
    version: Version
  ): void {
    const changelogs = this.changelogUpdaters(update.updater);
    const matching = changelogs.filter(
      updater => updater.version.compare(version) === 0
    );
    if (changelogs.length > 0 && matching.length !== 1) {
      throw this.error(
        `cannot identify the ${version} changelog update at ${update.path}`
      );
    }
    if (matching.length === 1) {
      matching[0].changelogEntry =
        `${matching[0].changelogEntry.trim()}\n\n${note}`.trim();
    }
  }

  private changelogUpdaters(updater: Updater): Changelog[] {
    if (updater instanceof Changelog) return [updater];
    if (updater instanceof CompositeUpdater) {
      return updater.updaters.flatMap(part => this.changelogUpdaters(part));
    }
    return [];
  }

  private bump(version: Version, kind: 'patch' | 'minor' | 'major'): Version {
    switch (kind) {
      case 'major':
        return new MajorVersionUpdate().bump(version);
      case 'minor':
        return new MinorVersionUpdate().bump(version);
      case 'patch':
        return new PatchVersionUpdate().bump(version);
    }
  }

  private topologicalOrder(): string[] {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const order: string[] = [];
    const visit = (path: string) => {
      if (visiting.has(path)) {
        throw this.error(`cycle in release dependencies at ${path}`);
      }
      if (visited.has(path)) return;
      visiting.add(path);
      for (const rule of this.rules.filter(rule => rule.dependent === path)) {
        visit(rule.source);
      }
      visiting.delete(path);
      visited.add(path);
      order.push(path);
    };
    for (const path of Object.keys(this.repositoryConfig).sort()) visit(path);
    return order;
  }

  private error(message: string): ConfigurationError {
    return new ConfigurationError(
      message,
      'release-dependencies',
      `${this.github.repository.owner}/${this.github.repository.repo}`
    );
  }
}
