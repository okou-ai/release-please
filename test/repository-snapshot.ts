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

import * as assert from 'assert';
import {createHash} from 'crypto';
import {execFile} from 'child_process';
import {mkdtemp, readFile, rm, writeFile} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {promisify} from 'util';
import {afterEach, describe, it} from 'mocha';
import * as nock from 'nock';
import {GitHub} from '../src/github';
import {GitHubApi} from '../src/github-api';
import {LocalGitHub} from '../src/local-github';
import {CargoToml} from '../src/updaters/rust/cargo-toml';
import {RawContent} from '../src/updaters/raw-content';
import {PullRequestTitle} from '../src/util/pull-request-title';
import {PullRequestBody} from '../src/util/pull-request-body';
import {TreeObject} from '../src/util/code-suggester/types';
import {Version} from '../src/version';

nock.disableNetConnect();
const fetch = require('node-fetch');
const exec = promisify(execFile);
const api = 'https://api.github.com';
const repo = '/repos/fake/fake';
const baseSha = 'b'.repeat(40);
const branch = 'release-please--branches--main';
const original = '[package]\nname = "demo"\nversion = "0.24.6"\n# café 中文\n';
const updated = original.replace('0.24.6', '0.24.7');

function blobSha(content: string) {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');
}

function branchSnapshot(scope: nock.Scope, ref: string, sha: string) {
  scope
    .get(`${repo}/git/ref/${encodeURIComponent(`heads/${ref}`)}`)
    .reply(200, {ref: `refs/heads/${ref}`, object: {type: 'commit', sha}});
}

function source(scope: nock.Scope, sha: string, files: Record<string, string>) {
  scope.get(`${repo}/git/trees/${sha}?recursive=true`).reply(200, {
    tree: Object.entries(files).map(([path, content]) => ({
      path,
      type: 'blob',
      mode: '100644',
      sha: blobSha(content),
    })),
    truncated: false,
  });
  for (const text of Object.values(files)) {
    scope
      .get(`${repo}/git/blobs/${blobSha(text)}`)
      .reply(200, {content: Buffer.from(text).toString('base64')});
  }
}

function publication(scope: nock.Scope, parent: string, existing = false) {
  const changes: TreeObject[][] = [];
  scope.get(`${repo}/git/ref/heads%2F${branch}`).reply(existing ? 200 : 404, {
    ref: `refs/heads/${branch}`,
  });
  if (!existing) {
    scope
      .post(`${repo}/git/refs`, {ref: `refs/heads/${branch}`, sha: parent})
      .reply(201, {ref: `refs/heads/${branch}`});
  }
  scope
    .get(`${repo}/git/commits/${parent}`)
    .reply(200, {tree: {sha: 'base-tree'}})
    .post(`${repo}/git/trees`, body => {
      assert.strictEqual(body.base_tree, 'base-tree');
      changes.push(body.tree);
      return true;
    })
    .reply(201, {sha: 'release-tree'})
    .post(`${repo}/git/commits`, body => {
      assert.deepStrictEqual(body.parents, [parent]);
      return true;
    })
    .reply(201, {sha: 'c'.repeat(40)})
    .patch(`${repo}/git/refs/heads%2F${branch}`, {
      sha: 'c'.repeat(40),
      force: true,
    })
    .reply(200)
    .get(`${repo}/pulls`)
    .query({head: `fake:${branch}`})
    .reply(200, [{number: 123, head: {label: `fake:${branch}`}}]);
  const receipt = {
    number: 123,
    head: {ref: branch},
    base: {ref: 'main'},
    labels: [],
    title: 'chore: release main',
    body: 'notes',
  };
  if (existing) {
    scope.patch(`${repo}/pulls/123`).reply(200, receipt);
  } else {
    scope.get(`${repo}/pulls/123`).reply(200, receipt);
  }
  return changes;
}

async function github() {
  return GitHub.create({
    owner: 'fake',
    repo: 'fake',
    defaultBranch: 'main',
    fetch,
  });
}

async function git(cwd: string, ...args: string[]) {
  return exec('git', args, {cwd});
}

async function commit(cwd: string, message: string) {
  await git(cwd, 'add', 'Cargo.toml');
  await git(
    cwd,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    message
  );
  return (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim();
}

describe('immutable repository snapshots', () => {
  afterEach(() => nock.cleanAll());

  for (const operation of ['create', 'update']) {
    for (const readRef of ['main', 'refs/heads/main']) {
      it(`uses the ${readRef} file snapshot as the commit parent during ${operation}`, async () => {
        const client = await github();
        const scope = nock(api);
        let head = baseSha;
        scope
          .get(`${repo}/git/ref/heads%2Fmain`)
          .reply(() => [200, {object: {type: 'commit', sha: head}}]);
        source(scope, baseSha, {'Cargo.toml': original});
        await client.getFileContentsOnBranch('Cargo.toml', readRef);
        // Subsequent main reads would now return a different commit, but neither
        // file generation nor publication may reread its moving head.
        head = 'd'.repeat(40);
        const otherRef = readRef === 'main' ? 'refs/heads/main' : 'main';
        assert.strictEqual(
          (await client.getFileContentsOnBranch('Cargo.toml', otherRef))
            .parsedContent,
          original
        );
        const changes = publication(scope, baseSha, operation === 'update');
        const updates = [
          {
            path: 'Cargo.toml',
            createIfMissing: false,
            // Workspace updaters may already have generated a whole-file result
            // from a cached read, so the commit parent must match that read.
            updater:
              readRef === 'main'
                ? new CargoToml({
                    version: Version.parse('0.24.7'),
                    versionsMap: new Map(),
                  })
                : new RawContent(updated),
          },
        ];
        const result =
          operation === 'create'
            ? await client.createPullRequest(
                {
                  number: 0,
                  headBranchName: branch,
                  baseBranchName: 'main',
                  title: 'chore: release main',
                  body: 'notes',
                  labels: [],
                  files: [],
                },
                'main',
                'chore: release main',
                updates,
                {fork: false}
              )
            : await client.updatePullRequest(
                123,
                {
                  title: PullRequestTitle.ofTargetBranch('main'),
                  body: new PullRequestBody([]),
                  headRefName: branch,
                  updates,
                  labels: [],
                  draft: false,
                },
                'main',
                {fork: false}
              );
        assert.strictEqual(result.number, 123);
        assert.deepStrictEqual(changes, [
          [
            {
              path: 'Cargo.toml',
              type: 'blob',
              mode: '100644',
              content: updated,
            },
          ],
        ]);
        scope.done();
      });
    }
  }

  it('shares a resolved commit across concurrent readers and history pages', async () => {
    const client = await github();
    const scope = nock(api);
    branchSnapshot(scope, 'main', baseSha);
    source(scope, baseSha, {'Cargo.toml': original});
    for (const [sha, cursor, next] of [
      [baseSha, undefined, 'page-2'],
      ['a'.repeat(40), 'page-2', undefined],
    ]) {
      scope
        .post('/graphql', body => {
          assert.ok(body.query.includes('object(expression: $targetBranch)'));
          assert.strictEqual(body.variables.targetBranch, baseSha);
          assert.strictEqual(body.variables.cursor, cursor);
          return true;
        })
        .reply(200, {
          data: {
            repository: {
              object: {
                history: {
                  nodes: [
                    {
                      sha,
                      message: 'fix: demo',
                      associatedPullRequests: {nodes: []},
                    },
                  ],
                  pageInfo: {hasNextPage: !!next, endCursor: next},
                },
              },
            },
          },
        });
    }
    const [file, history] = await Promise.all([
      client.getFileContentsOnBranch('Cargo.toml', 'refs/heads/main'),
      client.commitsSince('main', () => false),
    ]);
    assert.strictEqual(file.parsedContent, original);
    assert.deepStrictEqual(
      history.map(commit => commit.sha),
      [baseSha, 'a'.repeat(40)]
    );
    assert.deepStrictEqual(await client.findFilesByFilename('Cargo.toml'), [
      'Cargo.toml',
    ]);
    assert.deepStrictEqual(await client.findFilesByExtension('toml'), [
      'Cargo.toml',
    ]);
    assert.deepStrictEqual(await client.findFilesByGlob('*.toml'), [
      'Cargo.toml',
    ]);
    scope.done();
  });

  it('reads an explicit immutable SHA without resolving a branch', async () => {
    const scope = nock(api);
    source(scope, baseSha, {'Cargo.toml': original});
    assert.strictEqual(
      (await (await github()).getFileContentsOnBranch('Cargo.toml', baseSha))
        .parsedContent,
      original
    );
    scope.done();
  });

  it('keeps independent snapshots for different branch refs', async () => {
    const client = await github();
    const scope = nock(api);
    for (const [ref, sha, content] of [
      ['main', baseSha, original],
      ['release/1.x', 'a'.repeat(40), updated],
    ]) {
      branchSnapshot(scope, ref, sha);
      source(scope, sha, {'Cargo.toml': content});
      assert.strictEqual(
        (await client.getFileContentsOnBranch('Cargo.toml', ref)).parsedContent,
        content
      );
    }
    assert.strictEqual(
      (await client.getFileContents('Cargo.toml')).parsedContent,
      original
    );
    scope.done();
  });

  it('allows a failed initial ref resolution to be retried', async () => {
    const client = await github();
    const scope = nock(api);
    scope
      .get(`${repo}/git/ref/heads%2Fmain`)
      .reply(500, {message: 'Temporary error'})
      .get(`${repo}/git/ref/heads%2Fmain`)
      .reply(200, {object: {type: 'commit', sha: baseSha}});
    source(scope, baseSha, {'Cargo.toml': original});
    await assert.rejects(client.getFileContents('Cargo.toml'), {status: 500});
    assert.strictEqual(
      (await client.getFileContents('Cargo.toml')).parsedContent,
      original
    );
    scope.done();
  });

  it('keeps a same-named tag separate from a branch snapshot', async () => {
    const client = await github();
    const scope = nock(api);
    branchSnapshot(scope, 'main', baseSha);
    source(scope, baseSha, {'Cargo.toml': original});
    const tagSha = 'a'.repeat(40);
    scope
      .get(`${repo}/commits/refs%2Ftags%2Fmain`)
      .matchHeader('accept', 'application/vnd.github.sha')
      .reply(200, tagSha);
    source(scope, tagSha, {'Cargo.toml': updated});
    assert.strictEqual(
      (await client.getFileContentsOnBranch('Cargo.toml', 'refs/tags/main'))
        .parsedContent,
      updated
    );
    for (const ref of ['main', 'refs/heads/main']) {
      assert.strictEqual(
        (await client.getFileContentsOnBranch('Cargo.toml', ref)).parsedContent,
        original
      );
    }
    scope.done();
  });

  it('shares bare and qualified tag snapshots without treating them as branches', async () => {
    const client = await github();
    const scope = nock(api)
      .get(`${repo}/git/ref/heads%2Fv1`)
      .reply(404, {message: 'Not Found'})
      .get(`${repo}/commits/refs%2Ftags%2Fv1`)
      .matchHeader('accept', 'application/vnd.github.sha')
      .reply(200, baseSha);
    source(scope, baseSha, {'Cargo.toml': original});
    assert.strictEqual(
      (await client.getFileContentsOnBranch('Cargo.toml', 'v1')).parsedContent,
      original
    );
    assert.strictEqual(
      (await client.getFileContentsOnBranch('Cargo.toml', 'refs/tags/v1'))
        .parsedContent,
      original
    );
    scope.get(`${repo}/git/ref/heads%2Fv1`).reply(404, {message: 'Not Found'});
    await assert.rejects(
      client.getFileContentsOnBranch('Cargo.toml', 'refs/heads/v1'),
      {status: 404}
    );
    scope.done();
  });

  it('rejects an invalid commit resolution before reading files or writing', async () => {
    const scope = nock(api)
      .get(`${repo}/git/ref/heads%2Fmain`)
      .reply(200, {object: {type: 'commit', sha: 'invalid'}});
    await assert.rejects(
      (await github()).getFileContents('Cargo.toml'),
      /Could not resolve refs\/heads\/main to a commit SHA/
    );
    scope.done();
  });

  it('returns empty history for a missing branch', async () => {
    const scope = nock(api)
      .get(`${repo}/git/ref/heads%2Fmissing`)
      .reply(404, {message: 'Not Found'})
      .get(`${repo}/commits/refs%2Ftags%2Fmissing`)
      .reply(404, {message: 'Not Found'});
    assert.deepStrictEqual(
      await (await github()).commitsSince('missing', () => false),
      []
    );
    scope.done();
  });

  it('preserves pinned reads of Git revision expressions', async () => {
    const client = await github();
    const scope = nock(api)
      .get(`${repo}/git/ref/heads%2Fmain~1`)
      .reply(422, {message: 'Invalid ref'})
      .get(`${repo}/commits/main~1`)
      .matchHeader('accept', 'application/vnd.github.sha')
      .reply(200, baseSha);
    source(scope, baseSha, {'Cargo.toml': original});
    assert.strictEqual(
      (await client.getFileContentsOnBranch('Cargo.toml', 'main~1'))
        .parsedContent,
      original
    );
    assert.strictEqual(
      (await client.getFileContentsOnBranch('Cargo.toml', 'main~1'))
        .parsedContent,
      original
    );
    scope.done();
  });

  it('preserves an empty original while building a pinned changeset', async () => {
    const client = await github();
    const scope = nock(api);
    branchSnapshot(scope, 'main', baseSha);
    source(scope, baseSha, {file: ''});
    const changes = await client.buildChangeSet(
      [{path: 'file', createIfMissing: false, updater: new RawContent('new')}],
      'main'
    );
    assert.strictEqual(changes.get('file')?.originalContent, '');
    scope.done();
  });

  it('does not resolve or publish a snapshot when there are no updates', async () => {
    const result = await (
      await github()
    ).createPullRequest(
      {
        number: 0,
        headBranchName: branch,
        baseBranchName: 'main',
        title: 'release',
        body: 'notes',
        labels: [],
        files: [],
      },
      'main',
      'release',
      [],
      {fork: false}
    );
    // All HTTP requests are disabled and none are mocked for this no-op.
    assert.strictEqual(result.number, 0);
  });

  for (const readRef of ['main', 'refs/heads/main']) {
    it(`merges a local release read from ${readRef} without deleting a later dependency`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'release-snapshot-'));
      try {
        await exec('git', ['init', '--initial-branch=main', dir]);
        await writeFile(join(dir, 'Cargo.toml'), original);
        const parent = await commit(dir, 'initial');
        const apiClient = await GitHubApi.create({
          owner: 'fake',
          repo: 'fake',
          defaultBranch: 'main',
          fetch,
        });
        const client = new LocalGitHub(apiClient.repository, apiClient, dir);
        await client.getFileContentsOnBranch('Cargo.toml', readRef);
        const latest = original + '[dependencies]\nserde = "1.0"\n';
        await writeFile(join(dir, 'Cargo.toml'), latest);
        const newer = await commit(dir, 'feat: add serde');
        const dirty = 'uncommitted user work\n';
        await writeFile(join(dir, 'Cargo.toml'), dirty);
        const scope = nock(api);
        const changes = publication(scope, parent);
        await client.createPullRequest(
          {
            number: 0,
            headBranchName: branch,
            baseBranchName: 'main',
            title: 'release',
            body: 'notes',
            labels: [],
            files: [],
          },
          'main',
          'release',
          [
            {
              path: 'Cargo.toml',
              createIfMissing: false,
              updater: new RawContent(updated),
            },
          ],
          {fork: false}
        );
        assert.strictEqual(
          (await git(dir, 'rev-parse', 'HEAD')).stdout.trim(),
          newer
        );
        assert.strictEqual(
          await readFile(join(dir, 'Cargo.toml'), 'utf8'),
          dirty
        );
        assert.strictEqual(
          (await client.getFileContents('Cargo.toml')).parsedContent,
          original
        );
        assert.strictEqual(
          (
            await client.getFileContentsOnBranch(
              'Cargo.toml',
              'refs/heads/main'
            )
          ).parsedContent,
          original
        );
        assert.strictEqual(
          (await client.commitsSince('main', () => false))[0].sha,
          parent
        );
        scope.done();

        // Use the actual generated payload and verified parent in a real Git
        // three-way merge, independent of the HTTP fixture's tree implementation.
        const content = changes[0][0].content;
        assert.ok(typeof content === 'string');
        await git(dir, 'restore', 'Cargo.toml');
        await git(dir, 'checkout', '-b', 'release', parent);
        await writeFile(join(dir, 'Cargo.toml'), content);
        await commit(dir, 'release');
        await git(dir, 'checkout', 'main');
        await git(
          dir,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'merge',
          '--no-edit',
          'release'
        );
        const merged = await readFile(join(dir, 'Cargo.toml'), 'utf8');
        assert.match(merged, /version = "0.24.7"/);
        assert.match(merged, /serde = "1.0"/);
      } finally {
        await rm(dir, {recursive: true, force: true});
      }
    });
  }

  it('fetches missing local refs into separate snapshots concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-refs-'));
    const remote = join(root, 'remote');
    const clone = join(root, 'clone');
    try {
      await exec('git', ['init', '--initial-branch=main', remote]);
      await writeFile(join(remote, 'Cargo.toml'), original);
      await commit(remote, 'initial');
      await git(remote, 'checkout', '-b', 'release/1.x');
      await writeFile(join(remote, 'Cargo.toml'), updated);
      await commit(remote, 'release branch');
      await exec('git', ['init', '--initial-branch=main', clone]);
      await git(clone, 'remote', 'add', 'origin', remote);
      const apiClient = await GitHubApi.create({
        owner: 'fake',
        repo: 'fake',
        defaultBranch: 'main',
        fetch,
      });
      const client = new LocalGitHub(apiClient.repository, apiClient, clone);
      const files = await Promise.all([
        client.getFileContentsOnBranch('Cargo.toml', 'main'),
        client.getFileContentsOnBranch('Cargo.toml', 'release/1.x'),
        client.getFileContentsOnBranch('Cargo.toml', 'refs/heads/main'),
      ]);
      assert.deepStrictEqual(
        files.map(file => file.parsedContent),
        [original, updated, original]
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('keeps explicit local branch and tag names separate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-tag-'));
    try {
      await exec('git', ['init', '--initial-branch=main', dir]);
      await writeFile(join(dir, 'Cargo.toml'), original);
      await commit(dir, 'initial');
      await git(dir, 'tag', 'main');
      await writeFile(join(dir, 'Cargo.toml'), updated);
      await commit(dir, 'release');
      const apiClient = await GitHubApi.create({
        owner: 'fake',
        repo: 'fake',
        defaultBranch: 'main',
        fetch,
      });
      const client = new LocalGitHub(apiClient.repository, apiClient, dir);
      assert.strictEqual(
        (await client.getFileContentsOnBranch('Cargo.toml', 'refs/heads/main'))
          .parsedContent,
        updated
      );
      assert.strictEqual(
        (await client.getFileContentsOnBranch('Cargo.toml', 'refs/tags/main'))
          .parsedContent,
        original
      );
      // Preserve Git's native resolution of ambiguous short names instead of
      // accidentally assigning a tag snapshot to its fully qualified branch.
      assert.strictEqual(
        (await client.getFileContents('Cargo.toml')).parsedContent,
        original
      );
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
