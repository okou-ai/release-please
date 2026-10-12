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

import {afterEach, beforeEach, describe, it} from 'mocha';
import {expect} from 'chai';
import * as assert from 'assert';
import * as sinon from 'sinon';
import {mkdtemp, rm} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {execFile as execFileCallback} from 'child_process';
import {promisify} from 'util';
import {GitHubApi} from '../src/github-api';
import {LocalGitHub} from '../src/local-github';

const execFile = promisify(execFileCallback);
const sandbox = sinon.createSandbox();

describe('LocalGitHub getTagByName', () => {
  let cloneDir: string;
  let localGitHub: LocalGitHub;
  let githubApi: GitHubApi;
  let remoteLookup: sinon.SinonStub;
  let commitSha: string;

  function git(...args: string[]) {
    return execFile('git', args, {cwd: cloneDir});
  }

  beforeEach(async () => {
    cloneDir = await mkdtemp(join(tmpdir(), 'release-please-tag-test-'));
    await git('init', '--initial-branch=main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.com');
    await git('commit', '--allow-empty', '-m', 'Initial commit');
    commitSha = (await git('rev-parse', 'HEAD')).stdout.trim();
    githubApi = await GitHubApi.create({
      owner: 'fake',
      repo: 'fake',
      defaultBranch: 'main',
    });
    remoteLookup = sandbox.stub(githubApi, 'getTagByName').resolves(undefined);
    localGitHub = new LocalGitHub(githubApi.repository, githubApi, cloneDir);
  });

  afterEach(async () => {
    sandbox.restore();
    await rm(cloneDir, {recursive: true, force: true});
  });

  it('reads an exact lightweight tag locally', async () => {
    const tagName = '@scope/pkg-v1.0.0';
    await git('tag', tagName);
    expect(await localGitHub.getTagByName(tagName)).to.eql({
      name: tagName,
      sha: commitSha,
    });
    sinon.assert.notCalled(remoteLookup);
  });

  for (const depth of [1, 2]) {
    it(`peels ${depth} local annotated tags to the commit`, async () => {
      const tagName = 'pkg-v1.0.0';
      let target = 'HEAD';
      for (let index = 0; index < depth; index++) {
        const name = index + 1 === depth ? tagName : `annotation-${index}`;
        await git(
          '-c',
          'advice.nestedTag=false',
          'tag',
          '-a',
          name,
          '-m',
          'Annotated tag',
          target
        );
        target = name;
      }
      expect(await localGitHub.getTagByName(tagName)).to.eql({
        name: tagName,
        sha: commitSha,
      });
      sinon.assert.notCalled(remoteLookup);
    });
  }

  it('does not resolve a same-named branch or a tag-prefix match', async () => {
    const tagName = 'pkg-v1.0.0';
    await git('branch', tagName);
    await git('tag', `${tagName}/child`);
    expect(await localGitHub.getTagByName(tagName)).to.be.undefined;
    sinon.assert.calledOnceWithExactly(remoteLookup, tagName);
  });

  it('looks up a tag missing from a shallow clone through the API', async () => {
    const tag = {name: 'old-v1.0.0', sha: 'remote-commit'};
    remoteLookup.resolves(tag);
    expect(await localGitHub.getTagByName(tag.name)).to.eql(tag);
    sinon.assert.calledOnceWithExactly(remoteLookup, tag.name);
  });

  it('propagates local repository errors without querying the API', async () => {
    localGitHub = new LocalGitHub(
      githubApi.repository,
      githubApi,
      join(cloneDir, 'missing-directory')
    );
    await assert.rejects(localGitHub.getTagByName('pkg-v1.0.0'), {
      code: 'ENOENT',
    });
    sinon.assert.notCalled(remoteLookup);
  });
});
