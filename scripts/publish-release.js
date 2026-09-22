'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { verifyDist } = require('./verify-dist');

const REPOSITORY = 'vista-zhangg/WorkMeow';

function getReleaseByTag(api, tag) {
  // The tag endpoint only exposes published releases. Resolve draft IDs via the list.
  const release = api('releases?per_page=100').find((item) => item.tag_name === tag);
  return release ? api(`releases/${release.id}`) : null;
}

function verifyReleaseAssets(release, result) {
  const assets = release.assets || [];
  if (release.tag_name !== `v${result.version}` || assets.length !== result.files.length) {
    throw new Error('Release tag or asset count does not match the verified build');
  }
  for (const name of result.files) {
    const matches = assets.filter((asset) => asset.name === name);
    const asset = matches.length === 1 ? matches[0] : null;
    if (!asset || asset.state !== 'uploaded' || asset.size !== fs.statSync(path.join(result.dist, name)).size
        || asset.digest !== `sha256:${result.sha256[name]}`) {
      throw new Error(`GitHub asset integrity check failed: ${name}`);
    }
  }
}

async function publishRelease() {
  const result = verifyDist();
  const tag = `v${result.version}`;
  if (process.env.GITHUB_REF_NAME !== tag || process.env.GITHUB_REPOSITORY !== REPOSITORY) {
    throw new Error('Publishing must run in the matching repository tag workflow');
  }
  const notes = path.join(__dirname, '..', 'docs', 'releases', `${result.version}.md`);
  if (!fs.existsSync(notes) || !fs.readFileSync(notes, 'utf8').trim()) throw new Error('Versioned release notes are required');
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const api = (route) => JSON.parse(gh('api', `repos/${REPOSITORY}/${route}`));
  // Resume only an unpublished draft. Published versions are never overwritten.
  const existing = getReleaseByTag(api, tag);
  if (existing && !existing.draft) throw new Error(`${tag} is already published; publish a new version instead`);
  if (existing) {
    gh('release', 'edit', tag, '--repo', REPOSITORY, '--title', `打工喵 WorkMeow ${result.version}`, '--notes-file', notes);
    gh('release', 'upload', tag, ...result.files.map((name) => path.join(result.dist, name)), '--clobber', '--repo', REPOSITORY);
  } else {
    gh('release', 'create', tag, ...result.files.map((name) => path.join(result.dist, name)),
      '--draft', '--verify-tag', '--repo', REPOSITORY, '--title', `打工喵 WorkMeow ${result.version}`, '--notes-file', notes);
  }
  const draft = getReleaseByTag(api, tag);
  if (!draft || !draft.draft) throw new Error('Expected an unpublished draft before asset verification');
  const releaseRoute = `releases/${draft.id}`;
  // GitHub may need a short interval to populate newly uploaded asset digests.
  for (let attempt = 0; ; attempt++) {
    try { verifyReleaseAssets(api(releaseRoute), result); break; }
    catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  gh('release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest');
  const published = api(releaseRoute);
  verifyReleaseAssets(published, result);
  if (published.draft || api('releases/latest').tag_name !== tag) throw new Error('Release was not promoted to Latest');
  console.log(`Published and verified: ${published.html_url}`);
}

if (require.main === module) publishRelease().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { verifyReleaseAssets, getReleaseByTag };
