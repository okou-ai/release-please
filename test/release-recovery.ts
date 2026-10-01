// Copyright 2026 Google LLC
// Licensed under the Apache License, Version 2.0.

import {describe, it, beforeEach, afterEach} from 'mocha';
import {expect} from 'chai';
import * as sinon from 'sinon';
import * as nock from 'nock';
import {Manifest} from '../src/manifest';
import {GitHub, GitHubRelease} from '../src/github';
import {PullRequest} from '../src/pull-request';
import {Version} from '../src/version';
import {PullRequestBody} from '../src/util/pull-request-body';
import {DuplicateReleaseError} from '../src/errors';
import {RequestError} from '@octokit/request-error';
const fetch = require('node-fetch');
const source = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const annotation = 'c'.repeat(40);
const sandbox = sinon.createSandbox();
nock.disableNetConnect();

function original(): PullRequest {
  return {
    number: 42,
    title: 'chore: release main',
    baseBranchName: 'main',
    headBranchName: 'release-please/branches/main',
    sha: source,
    mergeCommitOid: source,
    labels: ['autorelease: tagged'],
    files: [],
    body: new PullRequestBody([
      {
        component: 'alpha',
        version: Version.parse('1.1.0'),
        notes: 'alpha changes',
      },
      {
        component: 'beta',
        version: Version.parse('2.0.0'),
        notes: 'beta changes',
      },
    ]).toString(),
  };
}
function release(tag: string): GitHubRelease {
  return {
    id: 1,
    tagName: tag,
    sha: 'main',
    url: 'https://example.invalid/release',
    draft: false,
    prerelease: false,
  };
}
function manifest(github: GitHub): Manifest {
  return new Manifest(
    github,
    'main',
    {
      'packages/a': {
        releaseType: 'node',
        component: 'alpha',
        packageName: 'alpha',
      },
      'packages/b': {
        releaseType: 'node',
        component: 'beta',
        packageName: 'beta',
      },
    },
    {
      'packages/a': Version.parse('1.1.0'),
      'packages/b': Version.parse('2.0.0'),
    },
    {releaseTargetSha: source, releasePlanPaths: ['packages/a', 'packages/b']}
  );
}
async function rejected(promise: Promise<unknown>, text: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).instanceOf(Error);
  expect((error as Error).message).contains(text);
}

describe('source-bound release reconciliation', () => {
  let github: GitHub;
  let releases: Map<string, GitHubRelease>;
  let tags: Map<string, string>;
  let create: sinon.SinonStub;
  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'fake',
      repo: 'repo',
      defaultBranch: 'main',
      fetch,
    });
    releases = new Map();
    tags = new Map();
    sandbox.stub(github, 'releasePullRequestsForCommit').resolves([original()]);
    sandbox
      .stub(github, 'getReleaseByTag')
      .callsFake(async tag => releases.get(tag));
    sandbox.stub(github, 'getTagCommit').callsFake(async tag => tags.get(tag));
    sandbox.stub(github, 'ensureTagCommit').callsFake(async (tag, sha) => {
      if (tags.has(tag) && tags.get(tag) !== sha)
        throw new Error('source mismatch');
      tags.set(tag, sha);
    });
    create = sandbox
      .stub(github, 'createRelease')
      .callsFake(async candidate => {
        const tag = candidate.tag.toString();
        const value = release(tag);
        releases.set(tag, value);
        tags.set(tag, source);
        return value;
      });
    sandbox.stub(github, 'removeIssueLabels').resolves();
    sandbox.stub(github, 'addIssueLabels').resolves();
  });
  afterEach(() => {
    sandbox.restore();
    nock.cleanAll();
  });
  it('reconstructs a tagged original and returns created identities at its exact source', async () => {
    const result = await manifest(github).reconcileReleases();
    expect(
      result.map(x => [x.path, x.version, x.sha, x.releaseStatus])
    ).deep.equals([
      ['packages/a', '1.1.0', source, 'created'],
      ['packages/b', '2.0.0', source, 'created'],
    ]);
    sinon.assert.calledTwice(create);
    sinon.assert.calledOnceWithExactly(
      github.releasePullRequestsForCommit as sinon.SinonStub,
      source,
      'main'
    );
  });
  it('includes both existing and newly created components without relying on target_commitish', async () => {
    releases.set('alpha-v1.1.0', release('alpha-v1.1.0'));
    tags.set('alpha-v1.1.0', source);
    const result = await manifest(github).reconcileReleases();
    expect(result.map(x => x.releaseStatus)).deep.equals([
      'existing',
      'created',
    ]);
    expect(result[0].sha).equals(source);
    sinon.assert.calledOnce(create);
  });
  it('replays an all-existing plan without recreating tags', async () => {
    for (const tag of ['alpha-v1.1.0', 'beta-v2.0.0']) {
      releases.set(tag, release(tag));
      tags.set(tag, source);
    }
    const result = await manifest(github).reconcileReleases();
    expect(result.map(x => x.releaseStatus)).deep.equals([
      'existing',
      'existing',
    ]);
    sinon.assert.notCalled(create);
  });
  it('recovers all original components after a partial creation error', async () => {
    create.onSecondCall().rejects(new Error('provider unavailable'));
    await rejected(
      manifest(github).reconcileReleases(),
      'provider unavailable'
    );
    const result = await manifest(github).reconcileReleases();
    expect(result.map(x => x.releaseStatus)).deep.equals([
      'existing',
      'created',
    ]);
  });
  it('recovers after finalization failure even when all releases already exist', async () => {
    const labels = github.addIssueLabels as sinon.SinonStub;
    labels.onFirstCall().rejects(new Error('label failure'));
    await rejected(manifest(github).reconcileReleases(), 'label failure');
    const result = await manifest(github).reconcileReleases();
    expect(result.every(x => x.releaseStatus === 'existing')).equals(true);
    sinon.assert.calledTwice(create);
  });
  it('rejects a wrong-source tag before creating any component, even without a release', async () => {
    tags.set('beta-v2.0.0', parent);
    await rejected(manifest(github).reconcileReleases(), 'source mismatch');
    sinon.assert.notCalled(create);
  });
  it('does not treat provider failures as absence', async () => {
    (github.getReleaseByTag as sinon.SinonStub).rejects(
      new Error('permission denied')
    );
    await rejected(manifest(github).reconcileReleases(), 'permission denied');
    sinon.assert.notCalled(create);
  });
  it('rejects changed source versions and incomplete original notes before any mutation', async () => {
    const pr = original();
    (github.releasePullRequestsForCommit as sinon.SinonStub).resolves([
      {...pr, body: pr.body!.replace('1.1.0', '9.9.9')},
    ]);
    await rejected(manifest(github).reconcileReleases(), 'version mismatch');
    sinon.assert.notCalled(create);
    (github.releasePullRequestsForCommit as sinon.SinonStub).resolves([]);
    await rejected(
      manifest(github).reconcileReleases(),
      'original release plan'
    );
    sinon.assert.notCalled(create);
  });
  it('rejects ambiguous originals', async () => {
    (github.releasePullRequestsForCommit as sinon.SinonStub).resolves([
      original(),
      {...original(), number: 43},
    ]);
    await rejected(manifest(github).reconcileReleases(), 'ambiguous');
    sinon.assert.notCalled(create);
  });
  it('validates a duplicate race by strict readback', async () => {
    create.onFirstCall().callsFake(async candidate => {
      const tag = candidate.tag.toString();
      releases.set(tag, release(tag));
      tags.set(tag, source);
      throw new DuplicateReleaseError(
        new RequestError('exists', 422, {
          request: {method: 'POST', url: 'https://api.github.com', headers: {}},
        }),
        'tagName'
      );
    });
    const result = await manifest(github).reconcileReleases();
    expect(result[0].releaseStatus).equals('existing');
  });
  it('prevents targeted mode from entering mutable legacy or release-PR generation', async () => {
    await rejected(manifest(github).createReleases(), 'reconcileReleases');
    await rejected(manifest(github).createPullRequests(), 'cannot create');
  });
  it('loads original config/version delta and freezes component identity without reading latest main', async () => {
    const get = sandbox.stub(github, 'getFileJson');
    get.withArgs('release-please-config.json', source).resolves({
      packages: {
        'packages/a': {'release-type': 'node', component: 'alpha'},
        'packages/b': {'release-type': 'node', component: 'beta'},
        'packages/unchanged': {'release-type': 'node', component: 'other'},
      },
    });
    get.withArgs('.release-please-manifest.json', source).resolves({
      'packages/a': '1.1.0',
      'packages/b': '2.0.0',
      'packages/unchanged': '1.0.0',
    });
    get.withArgs('.release-please-manifest.json', parent).resolves({
      'packages/a': '1.0.0',
      'packages/b': '1.0.0',
      'packages/unchanged': '1.0.0',
    });
    sandbox.stub(github, 'getCommitParent').withArgs(source).resolves(parent);
    const target = await Manifest.fromManifest(
      github,
      'main',
      undefined,
      undefined,
      {releaseTargetSha: source}
    );
    expect((await target.reconcileReleases()).map(x => x.path)).deep.equals([
      'packages/a',
      'packages/b',
    ]);
    expect(
      get.getCalls().every(x => x.args[1] === source || x.args[1] === parent)
    ).equals(true);
  });
});

describe('original release GitHub identity boundaries', () => {
  let github: GitHub;
  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'fake',
      repo: 'repo',
      defaultBranch: 'main',
      fetch,
    });
  });
  afterEach(() => {
    sandbox.restore();
    nock.cleanAll();
  });
  const refPath =
    /\/repos\/fake\/repo\/git\/ref\/tags(?:\/|%2F)alpha-v1\.1\.0$/;
  it('resolves lightweight and annotated tags using actual commit identities', async () => {
    nock('https://api.github.com')
      .get(refPath)
      .reply(200, {object: {type: 'commit', sha: source}});
    expect(await github.getTagCommit('alpha-v1.1.0')).equals(source);
    nock('https://api.github.com')
      .get(refPath)
      .reply(200, {object: {type: 'tag', sha: annotation}})
      .get(`/repos/fake/repo/git/tags/${annotation}`)
      .reply(200, {object: {type: 'commit', sha: source}});
    expect(await github.getTagCommit('alpha-v1.1.0')).equals(source);
  });
  it('rejects cyclic annotation identities', async () => {
    nock('https://api.github.com')
      .get(refPath)
      .reply(200, {object: {type: 'tag', sha: annotation}})
      .get(`/repos/fake/repo/git/tags/${annotation}`)
      .reply(200, {object: {type: 'tag', sha: annotation}});
    await rejected(github.getTagCommit('alpha-v1.1.0'), 'cyclic');
  });
  it('distinguishes missing objects from permission failures', async () => {
    nock('https://api.github.com').get(refPath).reply(404);
    expect(await github.getTagCommit('alpha-v1.1.0')).equals(undefined);
    nock('https://api.github.com')
      .get('/repos/fake/repo/releases/tags/alpha-v1.1.0')
      .reply(404);
    expect(await github.getReleaseByTag('alpha-v1.1.0')).equals(undefined);
    nock('https://api.github.com')
      .get(refPath)
      .reply(403, {message: 'permission denied'});
    await rejected(github.getTagCommit('alpha-v1.1.0'), 'permission denied');
  });
  it('reserves a missing tag at the exact source and verifies create-ref races', async () => {
    nock('https://api.github.com')
      .get(refPath)
      .reply(404)
      .post('/repos/fake/repo/git/refs', {
        ref: 'refs/tags/alpha-v1.1.0',
        sha: source,
      })
      .reply(201)
      .get(refPath)
      .reply(200, {object: {type: 'commit', sha: source}});
    await github.ensureTagCommit('alpha-v1.1.0', source);
    nock('https://api.github.com')
      .get(refPath)
      .reply(404)
      .post('/repos/fake/repo/git/refs')
      .reply(422)
      .get(refPath)
      .reply(200, {object: {type: 'commit', sha: parent}});
    await rejected(
      github.ensureTagCommit('alpha-v1.1.0', source),
      'source mismatch'
    );
  });
  it('rejects malformed release metadata rather than emit incomplete readiness', async () => {
    nock('https://api.github.com')
      .get('/repos/fake/repo/releases/tags/alpha-v1.1.0')
      .reply(200, {
        id: 1,
        tag_name: 'another-tag',
        target_commitish: 'main',
        html_url: 'https://example.invalid',
        draft: false,
        prerelease: false,
      });
    await rejected(
      github.getReleaseByTag('alpha-v1.1.0'),
      'Malformed release metadata'
    );
  });
  it('validates commit parent identity and rejects invalid targets before requests', async () => {
    nock('https://api.github.com')
      .get(`/repos/fake/repo/commits/${source}`)
      .reply(200, {sha: source, parents: [{sha: parent}]});
    expect(await github.getCommitParent(source)).equals(parent);
    await rejected(github.getCommitParent('main'), 'Invalid release target');
  });
  it('rejects excessive annotation depth and non-commit tag objects', async () => {
    const hashes = Array.from({length: 7}, (_, i) => String(i + 1).repeat(40));
    nock('https://api.github.com')
      .get(refPath)
      .reply(200, {object: {type: 'tag', sha: hashes[0]}});
    for (let i = 0; i < 6; i++)
      nock('https://api.github.com')
        .get(`/repos/fake/repo/git/tags/${hashes[i]}`)
        .reply(200, {object: {type: 'tag', sha: hashes[i + 1]}});
    await rejected(github.getTagCommit('alpha-v1.1.0'), 'depth exceeded');
    nock('https://api.github.com')
      .get(refPath)
      .reply(200, {object: {type: 'tree', sha: source}});
    await rejected(
      github.getTagCommit('alpha-v1.1.0'),
      'does not point to a commit'
    );
  });
  it('looks up only the original commit PR regardless of labels or newer commits', async () => {
    nock('https://api.github.com')
      .post('/graphql', body => body.variables.sha === source)
      .reply(200, {
        data: {
          repository: {
            object: {
              __typename: 'Commit',
              oid: source,
              associatedPullRequests: {
                pageInfo: {hasNextPage: false},
                nodes: [
                  {
                    number: 42,
                    title: 'chore: release main',
                    body: 'notes',
                    state: 'MERGED',
                    baseRefName: 'main',
                    headRefName: 'release-please/main',
                    mergeCommit: {oid: source},
                    labels: {nodes: [{name: 'autorelease: tagged'}]},
                  },
                  {
                    number: 43,
                    title: 'newer',
                    body: 'notes',
                    state: 'MERGED',
                    baseRefName: 'main',
                    headRefName: 'release-please/newer',
                    mergeCommit: {oid: parent},
                    labels: {nodes: []},
                  },
                ],
              },
            },
          },
        },
      });
    expect(
      (await github.releasePullRequestsForCommit(source, 'main')).map(
        x => x.number
      )
    ).deep.equals([42]);
  });
});
