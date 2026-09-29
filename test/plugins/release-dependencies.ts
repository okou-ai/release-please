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

import {describe, it, beforeEach, afterEach} from 'mocha';
import * as sinon from 'sinon';
import {expect} from 'chai';
import {GitHub} from '../../src/github';
import {
  CandidateReleasePullRequest,
  Manifest,
  PluginType,
  ReleaseDependencyRule,
  RepositoryConfig,
} from '../../src/manifest';
import * as assert from 'assert';
import {Version} from '../../src/version';
import {Commit} from '../../src/commit';
import {ConfigurationError} from '../../src/errors';
import {ManifestPlugin} from '../../src/plugin';
import {
  mockCommits,
  mockReleases,
  mockPullRequests,
  stubFilesFromFixtures,
} from '../helpers';

const sandbox = sinon.createSandbox();
const source = 'node/source';
const dependent = 'crates/dependent';
const baseSha = 'base';
const versions = {
  [source]: Version.parse('9.0.0'),
  [dependent]: Version.parse('0.1.0'),
};
const packages: RepositoryConfig = {
  [source]: {releaseType: 'simple', component: 'source'},
  [dependent]: {releaseType: 'simple', component: 'dependent'},
};
const rule: ReleaseDependencyRule = {
  source,
  dependent,
  minimumBump: 'patch',
};

function commit(sha: string, message: string, files: string[]): Commit {
  return {sha, message, files};
}

describe('ReleaseDependencies plugin', () => {
  let github: GitHub;
  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'fake-owner',
      repo: 'fake-repo',
      defaultBranch: 'main',
    });
  });
  afterEach(() => sandbox.restore());

  function setup(
    paths: RepositoryConfig,
    currentVersions: Record<string, Version>,
    commits: Commit[],
    rules: ReleaseDependencyRule[],
    otherPlugins: PluginType[] = [],
    separatePullRequests = false,
    groupPullRequestTitlePattern?: string
  ): Manifest {
    const releases = Object.keys(paths).map((path, index) => ({
      id: index + 1,
      sha: baseSha,
      name: path,
      tagName: `${paths[path].component}-v${currentVersions[path]}`,
      url: `https://github.com/fake-owner/fake-repo/releases/tag/${path}`,
    }));
    mockReleases(sandbox, github, releases).callsFake(async function* () {
      yield* releases;
    });
    const history = [...commits, commit(baseSha, 'chore: last release', [])];
    mockCommits(sandbox, github, history).callsFake(async function* () {
      yield* history;
    });
    return new Manifest(github, 'main', paths, currentVersions, {
      separatePullRequests,
      groupPullRequestTitlePattern,
      plugins: [...otherPlugins, {type: 'release-dependencies', rules}],
    });
  }

  it('creates a separately versioned dependent release with manifest, notes, and a tag', async () => {
    const manifest = setup(
      packages,
      versions,
      [commit('change', 'feat: change source', [`${source}/index.ts`])],
      [rule]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    expect(
      pullRequest.body.releaseData.map(data => [
        data.component,
        data.version?.toString(),
      ])
    ).to.deep.equal([
      ['source', '9.1.0'],
      ['dependent', '0.1.1'],
    ]);
    expect(pullRequest.body.toString()).to.contain('### Release Dependencies');
    const update = pullRequest.updates.find(
      update => update.path === '.release-please-manifest.json'
    );
    expect(update?.updater).to.exist;
    const updatedManifest = JSON.parse(
      update!.updater.updateContent(
        JSON.stringify({
          [source]: '9.0.0',
          [dependent]: '0.1.0',
        })
      )
    );
    expect(updatedManifest[dependent]).to.equal('0.1.1');
    expect(
      pullRequest.updates.some(
        update => update.path === `${dependent}/version.txt`
      )
    ).to.be.true;
    const changelog = pullRequest.updates.find(
      update => update.path === `${dependent}/CHANGELOG.md`
    );
    expect(changelog?.updater.updateContent('')).to.contain(
      'Release Dependencies'
    );

    mockPullRequests(sandbox, github, [
      {
        number: 42,
        title: pullRequest.title.toString(),
        body: pullRequest.body.toString(),
        headBranchName: pullRequest.headRefName,
        baseBranchName: 'main',
        labels: ['autorelease: pending'],
        files: [],
        sha: 'released-sha',
      },
    ]);
    const releases = await manifest.buildReleases();
    expect(
      releases.map(release => [release.path, release.tag.toString()])
    ).to.deep.equal([
      [source, 'source-v9.1.0'],
      [dependent, 'dependent-v0.1.1'],
    ]);
  });

  it('preserves an independent dependent tag with a specialized strategy', async () => {
    const other = 'legacy/dependent';
    const manifest = setup(
      {
        [source]: packages[source],
        [other]: {releaseType: 'php-yoshi', component: 'dependent'},
      },
      {[source]: versions[source], [other]: versions[dependent]},
      [commit('change', 'fix: source', [`${source}/index.ts`])],
      [{source, dependent: other, minimumBump: 'minor'}]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    expect(
      pullRequest.body.releaseData
        .find(data => data.component === 'dependent')
        ?.version?.toString()
    ).to.equal('0.2.0');
    mockPullRequests(sandbox, github, [
      {
        number: 42,
        title: pullRequest.title.toString(),
        body: pullRequest.body.toString(),
        headBranchName: pullRequest.headRefName,
        baseBranchName: 'main',
        labels: ['autorelease: pending'],
        files: [],
        sha: 'released-sha',
      },
    ]);
    const releases = await manifest.buildReleases();
    expect(
      releases.find(release => release.path === other)?.tag.toString()
    ).to.equal('dependent-v0.2.0');
  });

  it('forces a publishable dependent release without replacing it with a snapshot', async () => {
    const manifest = setup(
      {
        [source]: packages[source],
        [dependent]: {releaseType: 'java', component: 'dependent'},
      },
      versions,
      [commit('change', 'fix: source', [`${source}/index.ts`])],
      [rule]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    expect(
      pullRequest.body.releaseData
        .find(data => data.component === 'dependent')
        ?.version?.toString()
    ).to.equal('0.1.1');
    mockPullRequests(sandbox, github, [
      {
        number: 42,
        title: pullRequest.title.toString(),
        body: pullRequest.body.toString(),
        headBranchName: pullRequest.headRefName,
        baseBranchName: 'main',
        labels: ['autorelease: pending'],
        files: [],
        sha: 'released-sha',
      },
    ]);
    const releases = await manifest.buildReleases();
    expect(
      releases.find(release => release.path === dependent)?.tag.toString()
    ).to.equal('dependent-v0.1.1');
  });

  it('does not release an unrelated specialized component from a combined PR', async () => {
    const other = 'legacy/dependent';
    const trigger = 'node/trigger';
    const manifest = setup(
      {
        [source]: packages[source],
        [trigger]: {releaseType: 'simple', component: 'trigger'},
        [other]: {releaseType: 'php-yoshi', component: 'dependent'},
      },
      {
        [source]: versions[source],
        [trigger]: Version.parse('1.0.0'),
        [other]: versions[dependent],
      },
      [commit('change', 'fix: unrelated source', [`${source}/index.ts`])],
      [{source: trigger, dependent: other}],
      [],
      false,
      'chore: release v${version}'
    );
    const [pullRequest] = await manifest.buildPullRequests();
    mockPullRequests(sandbox, github, [
      {
        number: 42,
        title: pullRequest.title.toString(),
        body: pullRequest.body.toString(),
        headBranchName: pullRequest.headRefName,
        baseBranchName: 'main',
        labels: ['autorelease: pending'],
        files: [],
        sha: 'released-sha',
      },
    ]);
    const releases = await manifest.buildReleases();
    expect(releases.map(release => release.path)).to.deep.equal([source]);
  });

  it('fails closed if another plugin removes a required version candidate', async () => {
    class DropDependent extends ManifestPlugin {
      async run(
        candidates: CandidateReleasePullRequest[]
      ): Promise<CandidateReleasePullRequest[]> {
        return candidates.filter(candidate => candidate.path !== dependent);
      }
    }
    const manifest = setup(
      packages,
      versions,
      [commit('change', 'fix: source', [`${source}/index.ts`])],
      [rule]
    );
    manifest.plugins.unshift(new DropDependent(github, 'main', packages));
    await assert.rejects(
      manifest.buildPullRequests(),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        /required release.*filtered/i.test(error.message)
    );
  });

  it('does not propagate a non-publishable source snapshot', async () => {
    const manifest = setup(
      {
        [source]: {releaseType: 'java', component: 'source'},
        [dependent]: packages[dependent],
      },
      versions,
      [],
      [rule]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    expect(
      pullRequest.body.releaseData.map(data => data.component)
    ).to.deep.equal(['source']);
    expect(pullRequest.body.releaseData[0].version?.preRelease).to.contain(
      'SNAPSHOT'
    );
  });

  it('adds dependency notes to a root-relative changelog', async () => {
    const manifest = setup(
      {
        ...packages,
        [dependent]: {
          ...packages[dependent],
          changelogPath: '/CHANGELOG-shared.md',
        },
      },
      versions,
      [commit('change', 'fix: source', [`${source}/index.ts`])],
      [rule]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    const changelog = pullRequest.updates.find(
      update => update.path === 'CHANGELOG-shared.md'
    );
    expect(changelog?.updater.updateContent('')).to.contain(
      'Release Dependencies'
    );
  });

  it('adds a note only to the dependent section of a shared changelog', async () => {
    const manifest = setup(
      {
        [source]: {
          ...packages[source],
          changelogPath: `/${dependent}/CHANGELOG.md`,
        },
        [dependent]: packages[dependent],
      },
      versions,
      [commit('change', 'fix: source', [`${source}/index.ts`])],
      [rule]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    const changelog = pullRequest.updates.find(
      update => update.path === `${dependent}/CHANGELOG.md`
    );
    const output = changelog?.updater.updateContent('');
    expect(output?.match(/Release Dependencies/g)).to.have.length(1);
    expect(output).to.contain('0.1.1');
  });

  it('fails closed when a shared changelog has indistinguishable versions', async () => {
    const manifest = setup(
      {
        [source]: {
          ...packages[source],
          changelogPath: `/${dependent}/CHANGELOG.md`,
        },
        [dependent]: packages[dependent],
      },
      {
        [source]: Version.parse('0.1.0'),
        [dependent]: Version.parse('0.1.0'),
      },
      [commit('change', 'fix: source', [`${source}/index.ts`])],
      [rule]
    );
    await assert.rejects(
      manifest.buildPullRequests(),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        /cannot identify.*changelog update/.test(error.message)
    );
  });

  it('does not release a dependent for a hidden source change without a source version bump', async () => {
    const manifest = setup(
      packages,
      versions,
      [commit('hidden', 'build: regenerate source', [`${source}/index.ts`])],
      [rule]
    );
    expect(await manifest.buildPullRequests()).to.be.empty;
  });

  it('regenerates the same release PR on repeated runs at the same revision', async () => {
    const manifest = setup(
      packages,
      versions,
      [commit('change', 'fix: change source', [`${source}/index.ts`])],
      [rule]
    );
    const [first] = await manifest.buildPullRequests();
    const [second] = await manifest.buildPullRequests();
    expect(second.body.toString()).to.equal(first.body.toString());
    expect(second.updates.map(update => update.path)).to.deep.equal(
      first.updates.map(update => update.path)
    );
  });

  it('requires a higher configured minimum than an existing direct patch', async () => {
    const manifest = setup(
      packages,
      versions,
      [
        commit('source', 'fix: source change', [`${source}/index.ts`]),
        commit('dependent', 'fix: direct dependent change', [
          `${dependent}/index.rs`,
        ]),
      ],
      [{...rule, minimumBump: 'minor'}]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    expect(
      pullRequest.body.releaseData
        .find(data => data.component === 'dependent')
        ?.version?.toString()
    ).to.equal('0.2.0');
  });

  it('does nothing on an unrelated change', async () => {
    const manifest = setup(
      packages,
      versions,
      [commit('change', 'fix: unrelated', ['another/package/src/index.ts'])],
      [rule]
    );
    expect(await manifest.buildPullRequests()).to.be.empty;
  });

  it('retains the larger direct bump and releases each dependent only once for fan-in', async () => {
    const secondSource = 'node/second';
    const allPackages: RepositoryConfig = {
      ...packages,
      [secondSource]: {releaseType: 'simple', component: 'second'},
    };
    const allVersions = {...versions, [secondSource]: Version.parse('1.2.0')};
    const manifest = setup(
      allPackages,
      allVersions,
      [
        commit('new', 'feat: dependent new feature', [
          `${dependent}/feature.ts`,
        ]),
        commit('source', 'fix: first source', [`${source}/index.ts`]),
        commit('second', 'fix: second source', [`${secondSource}/index.ts`]),
      ],
      [rule, {source: secondSource, dependent}]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    const dependentData = pullRequest.body.releaseData.filter(
      data => data.component === 'dependent'
    );
    expect(dependentData).to.have.length(1);
    expect(dependentData[0].version?.toString()).to.equal('0.2.0');
    expect(dependentData[0].notes).to.contain('node/source');
    expect(dependentData[0].notes).to.contain('node/second');
  });

  it('propagates a chain deterministically across packages', async () => {
    const downstream = 'other/downstream';
    const manifest = setup(
      {
        ...packages,
        [downstream]: {releaseType: 'simple', component: 'downstream'},
      },
      {...versions, [downstream]: Version.parse('3.0.0')},
      [commit('change', 'fix: source', [`${source}/index.ts`])],
      [{source: dependent, dependent: downstream}, rule]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    expect(
      pullRequest.body.releaseData.map(data => [
        data.component,
        data.version?.toString(),
      ])
    ).to.deep.equal([
      ['source', '9.0.1'],
      ['dependent', '0.1.1'],
      ['downstream', '3.0.1'],
    ]);
  });

  it('fails for unknown paths, duplicate edges, cycles, and unsupported rule fields', () => {
    const make = (rules: ReleaseDependencyRule[]) =>
      new Manifest(github, 'main', packages, versions, {
        plugins: [{type: 'release-dependencies', rules}],
      });
    expect(() => make([{source: 'missing', dependent}])).to.throw(
      ConfigurationError
    );
    expect(() => make([rule, rule])).to.throw(ConfigurationError, 'duplicate');
    expect(() => make([rule, {source: dependent, dependent: source}])).to.throw(
      ConfigurationError,
      'cycle'
    );
    const unsupportedRule = {...rule, inputPaths: ['pnpm-lock.yaml']};
    expect(() => make([unsupportedRule])).to.throw(
      ConfigurationError,
      'unsupported release dependency rule field'
    );
    expect(
      () =>
        new Manifest(
          github,
          'main',
          {
            ...packages,
            [dependent]: {...packages[dependent], separatePullRequests: true},
          },
          versions,
          {plugins: [{type: 'release-dependencies', rules: [rule]}]}
        )
    ).to.throw(ConfigurationError, 'combined release pull request');
    expect(
      () =>
        new Manifest(github, 'main', packages, versions, {
          separatePullRequests: true,
          plugins: [{type: 'release-dependencies', rules: [rule]}],
        })
    ).to.throw(ConfigurationError, 'combined release pull request');
  });

  it('permits an unrelated package to use separate release PRs', async () => {
    const unrelated = 'other/unrelated';
    const unrelatedPackages: RepositoryConfig = {
      ...packages,
      [unrelated]: {
        releaseType: 'simple',
        component: 'unrelated',
        separatePullRequests: true,
      },
    };
    const unrelatedVersions = {
      ...versions,
      [unrelated]: Version.parse('3.0.0'),
    };
    const manifest = setup(
      unrelatedPackages,
      unrelatedVersions,
      [commit('change', 'fix: source', [`${source}/index.ts`])],
      [rule]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    expect(
      pullRequest.body.releaseData.map(data => data.component)
    ).to.deep.equal(['source', 'dependent']);
  });

  it('does not create an empty combined PR when only a separate package changes', async () => {
    const unrelated = 'other/unrelated';
    const manifest = setup(
      {
        ...packages,
        [unrelated]: {
          releaseType: 'simple',
          component: 'unrelated',
          separatePullRequests: true,
        },
      },
      {...versions, [unrelated]: Version.parse('3.0.0')},
      [commit('unrelated', 'fix: another package', [`${unrelated}/index.ts`])],
      [rule]
    );
    const pullRequests = await manifest.buildPullRequests();
    expect(pullRequests).to.have.length(1);
    expect(
      pullRequests[0].body.releaseData.map(data => data.component)
    ).to.deep.equal(['unrelated']);
  });

  it('propagates from a Node package through two Cargo packages back into Node', async () => {
    const libC = 'crates/lib-c';
    const libD = 'crates/lib-d';
    const libE = 'node/lib-e';
    stubFilesFromFixtures({
      sandbox,
      github,
      fixturePath: './test/fixtures',
      files: [],
      targetBranch: 'main',
      inlineFiles: [
        [
          `${source}/package.json`,
          JSON.stringify({name: 'source', version: '9.0.0'}),
        ],
        [
          `${libE}/package.json`,
          JSON.stringify({name: 'lib-e', version: '2.0.0'}),
        ],
        [
          'Cargo.toml',
          '[workspace]\nmembers = ["crates/lib-c", "crates/lib-d"]',
        ],
        [`${libC}/Cargo.toml`, '[package]\nname = "lib-c"\nversion = "0.1.0"'],
        [
          `${libD}/Cargo.toml`,
          '[package]\nname = "lib-d"\nversion = "0.1.0"\n\n[dependencies]\nlib-c = { version = "0.1.0", path = "../lib-c" }',
        ],
      ],
    });
    sandbox
      .stub(github, 'findFilesByGlobAndRef')
      .withArgs('crates/lib-c', 'main')
      .resolves(['crates/lib-c'])
      .withArgs('crates/lib-d', 'main')
      .resolves(['crates/lib-d']);
    const manifest = setup(
      {
        [source]: {releaseType: 'node', component: 'source'},
        [libC]: {releaseType: 'rust', component: 'lib-c'},
        [libD]: {releaseType: 'rust', component: 'lib-d'},
        [libE]: {releaseType: 'node', component: 'lib-e'},
      },
      {
        [source]: Version.parse('9.0.0'),
        [libC]: Version.parse('0.1.0'),
        [libD]: Version.parse('0.1.0'),
        [libE]: Version.parse('2.0.0'),
      },
      [commit('change', 'fix: source', [`${source}/src/index.ts`])],
      [
        {source, dependent: libC},
        {source: libD, dependent: libE},
      ],
      [{type: 'node-workspace'}, {type: 'cargo-workspace'}]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    expect(
      Object.fromEntries(
        pullRequest.body.releaseData.map(data => [
          data.component,
          data.version?.toString(),
        ])
      )
    ).to.deep.equal({
      source: '9.0.1',
      'lib-e': '2.0.1',
      'lib-c': '0.1.1',
      'lib-d': '0.1.1',
    });
  });

  it('propagates an upstream workspace version bump across Node and Cargo', async () => {
    const nodeA = 'node/a';
    const nodeB = 'node/b';
    const libC = 'crates/lib-c';
    stubFilesFromFixtures({
      sandbox,
      github,
      fixturePath: './test/fixtures',
      files: [],
      targetBranch: 'main',
      inlineFiles: [
        [
          'node/a/package.json',
          JSON.stringify({name: 'pkg-a', version: '1.0.0'}),
        ],
        [
          'node/b/package.json',
          JSON.stringify({
            name: 'pkg-b',
            version: '1.0.0',
            dependencies: {'pkg-a': 'workspace:*'},
          }),
        ],
        ['crates/Cargo.toml', '[workspace]\nmembers = ["lib-c"]'],
        [
          'crates/lib-c/Cargo.toml',
          '[package]\nname = "lib-c"\nversion = "0.1.0"',
        ],
      ],
    });
    sandbox
      .stub(github, 'findFilesByGlobAndRef')
      .withArgs('crates/lib-c', 'main')
      .resolves(['crates/lib-c']);
    const manifest = setup(
      {
        [nodeA]: {releaseType: 'node', component: 'pkg-a'},
        [nodeB]: {
          releaseType: 'node',
          component: 'pkg-b',
          skipChangelog: true,
        },
        [libC]: {releaseType: 'rust', component: 'lib-c'},
      },
      {
        [nodeA]: Version.parse('1.0.0'),
        [nodeB]: Version.parse('1.0.0'),
        [libC]: Version.parse('0.1.0'),
      },
      [commit('change', 'feat: update a', [`${nodeA}/src/index.ts`])],
      [{source: nodeB, dependent: libC}],
      [
        {type: 'node-workspace'},
        {type: 'cargo-workspace', cargoWorkspacePath: 'crates'},
      ]
    );
    const [pullRequest] = await manifest.buildPullRequests();
    expect(
      pullRequest.body.releaseData.map(data => [
        data.component,
        data.version?.toString(),
      ])
    ).to.deep.equal([
      ['pkg-a', '1.1.0'],
      ['pkg-b', '1.0.1'],
      ['lib-c', '0.1.1'],
    ]);
    expect(pullRequest.body.toString()).to.contain('Release of `node/b`');
    mockPullRequests(sandbox, github, [
      {
        number: 42,
        title: pullRequest.title.toString(),
        body: pullRequest.body.toString(),
        headBranchName: pullRequest.headRefName,
        baseBranchName: 'main',
        labels: ['autorelease: pending'],
        files: [],
        sha: 'released-sha',
      },
    ]);
    const releases = await manifest.buildReleases();
    expect(
      releases.map(release => [release.path, release.tag.toString()])
    ).to.deep.equal([
      [nodeA, 'pkg-a-v1.1.0'],
      [nodeB, 'pkg-b-v1.0.1'],
      [libC, 'lib-c-v0.1.1'],
    ]);
  });
});
