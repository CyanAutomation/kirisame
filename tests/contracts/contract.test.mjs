import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import canonicalize from 'canonicalize';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const schemaDir = path.join(root, 'contracts/v1');
const validDir = path.join(here, 'valid');
const invalidDir = path.join(here, 'invalid');
const maxArtifactBytes = 5 * 1024 * 1024;
const maxManifestBytes = 8 * 1024 * 1024;
const supportedClasses = new Map([
  ['INVALID_REQUEST', 'invalid'],
  ['UNSUPPORTED_VERSION', 'invalid'],
  ['UNAUTHORIZED_CALLER', 'policy'],
  ['REPOSITORY_NOT_ALLOWED', 'policy'],
  ['APP_NOT_INSTALLED', 'policy'],
  ['GITHUB_PERMISSION_DENIED', 'policy'],
  ['ARTIFACT_INVALID', 'invalid'],
  ['ARTIFACT_DIGEST_MISMATCH', 'invalid'],
  ['ARTIFACT_PROVENANCE_MISMATCH', 'policy'],
  ['BASE_MOVED', 'conflict'],
  ['BRANCH_CONFLICT', 'conflict'],
  ['PULL_REQUEST_CONFLICT', 'conflict'],
  ['GITHUB_AUTH_UNAVAILABLE', 'retryable'],
  ['GITHUB_RATE_LIMITED', 'retryable'],
  ['GITHUB_UNAVAILABLE', 'retryable'],
  ['GITHUB_TIMEOUT', 'retryable'],
  ['RECONCILIATION_REQUIRED', 'retryable'],
  ['INTERNAL_ERROR', 'internal'],
]);

const schemaFiles = [
  'publication-artifact.schema.json',
  'publication-error.schema.json',
  'publication-event.schema.json',
  'publication-request.schema.json',
  'publication-result.schema.json',
];
const schemas = await Promise.all(schemaFiles.map(async (name) =>
  JSON.parse(await readFile(path.join(schemaDir, name), 'utf8'))));
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);

const schemaFor = new Map([
  ['publication-artifact', 'https://kirisame.cyanautomation.dev/contracts/v1/publication-artifact.schema.json'],
  ['publication-error', 'https://kirisame.cyanautomation.dev/contracts/v1/publication-error.schema.json'],
  ['publication-event', 'https://kirisame.cyanautomation.dev/contracts/v1/publication-event.schema.json'],
  ['publication-request', 'https://kirisame.cyanautomation.dev/contracts/v1/publication-request.schema.json'],
  ['publication-result', 'https://kirisame.cyanautomation.dev/contracts/v1/publication-result.schema.json'],
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(code, message) {
  return { source: 'semantic', code, message };
}

function artifactErrors(artifact) {
  const errors = [];
  if (artifact.fileCount !== artifact.files.length) errors.push(fail('FILE_COUNT_MISMATCH', 'fileCount must equal files.length'));
  const actualBytes = artifact.files.reduce((sum, file) => sum + (file.content?.byteLength ?? 0), 0);
  if (artifact.totalBytes !== actualBytes) errors.push(fail('TOTAL_BYTES_MISMATCH', 'totalBytes must equal the decoded content byte total'));
  if (actualBytes > maxArtifactBytes) errors.push(fail('ARTIFACT_TOO_LARGE', 'decoded artifact bytes exceed 5 MiB'));

  const manifestBytes = Buffer.byteLength(canonicalize(artifact) ?? '', 'utf8');
  if (manifestBytes > maxManifestBytes) errors.push(fail('MANIFEST_TOO_LARGE', 'canonical manifest exceeds 8 MiB'));

  const seen = new Set();
  const caseFolded = new Set();
  const paths = [];
  for (const file of artifact.files) {
    const filePath = file.path;
    const segments = filePath.split('/');
    const folded = filePath.toLowerCase();
    if (filePath.startsWith('/') || filePath.includes('\\') || filePath.includes(':') || /[\u0000-\u001f\u007f]/u.test(filePath)
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')
      || filePath.normalize('NFC') !== filePath
      || Buffer.byteLength(filePath, 'utf8') > 1024) {
      errors.push(fail('UNSAFE_PATH', 'path must be a normalized, bounded, relative POSIX repository path outside .git'));
    }
    if (seen.has(filePath) || caseFolded.has(folded)) errors.push(fail('DUPLICATE_OR_CONFLICTING_PATH', 'file paths must be unique, including case-folded collisions'));
    seen.add(filePath);
    caseFolded.add(folded);
    paths.push(filePath);

    if (file.content) {
      const content = file.content;
      let bytes;
      try {
        bytes = Buffer.from(content.data, 'base64');
        if (bytes.toString('base64') !== content.data) throw new Error('non-canonical base64');
      } catch {
        errors.push(fail('INVALID_BASE64', 'content.data must use canonical padded base64'));
        continue;
      }
      if (bytes.byteLength !== content.byteLength) errors.push(fail('CONTENT_LENGTH_MISMATCH', 'content.byteLength must match decoded bytes'));
      if (sha256(bytes) !== content.sha256) errors.push(fail('CONTENT_DIGEST_MISMATCH', 'content.sha256 must match decoded bytes'));
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded)) throw new Error('binary control character');
      } catch {
        errors.push(fail('UNSUPPORTED_FILE_TYPE', 'file content must be UTF-8 text without binary control bytes'));
      }
    }
  }
  const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (paths.some((value, index) => value !== sorted[index])) errors.push(fail('FILES_NOT_SORTED', 'files must be ordered by unsigned UTF-8 path bytes'));
  for (const filePath of paths) {
    const folded = filePath.toLowerCase();
    const components = folded.split('/');
    for (let index = 1; index < components.length; index++) {
      const parent = components.slice(0, index).join('/');
      if (caseFolded.has(parent)) errors.push(fail('DUPLICATE_OR_CONFLICTING_PATH', 'a file path cannot also be a parent directory'));
    }
    if (paths.some((other) => other !== filePath && other.toLowerCase().startsWith(folded + '/'))
      && !errors.some((error) => error.code === 'DUPLICATE_OR_CONFLICTING_PATH')) {
      errors.push(fail('DUPLICATE_OR_CONFLICTING_PATH', 'a file path cannot also be a parent directory'));
    }
  }
  return errors;
}

function semanticErrors(type, document) {
  const errors = [];
  if (type === 'publication-artifact') return artifactErrors(document);

  if (type === 'publication-request') {
    errors.push(...artifactErrors(document.artifact));
    if (document.artifact.runId !== document.runId
      || document.artifact.repository.owner !== document.repository.owner
      || document.artifact.repository.name !== document.repository.name
      || document.artifact.baseRef !== document.baseRef
      || document.artifact.baseSha !== document.baseSha) {
      errors.push(fail('ARTIFACT_PROVENANCE_MISMATCH', 'artifact run, repository and base must match the request'));
    }
    const canonical = canonicalize(document.artifact);
    if (!canonical || 'sha256:' + sha256(Buffer.from(canonical, 'utf8')) !== document.artifactDigest) {
      errors.push(fail('ARTIFACT_DIGEST_MISMATCH', 'artifactDigest must be SHA-256 of the RFC 8785 canonical artifact JSON'));
    }
    if (document.headRef !== 'kirisame/p/' + document.publicationId) {
      errors.push(fail('UNSAFE_HEAD_REF', 'headRef must be the deterministic Kirisame publication ref'));
    }
  }

  if (type === 'publication-error') {
    const classification = supportedClasses.get(document.code);
    if (classification && classification !== document.classification) {
      errors.push(fail('ERROR_CLASSIFICATION_MISMATCH', 'classification must match the documented error code'));
    }
  }

  if (type === 'publication-result') {
    if (document.outcome === 'branch_published' && (document.mode !== 'branch' || !document.branch || document.pullRequest || document.error)) {
      errors.push(fail('MALFORMED_RESULT', 'branch_published requires branch mode and a branch only'));
    }
    if (document.outcome === 'pr_published' && (document.mode !== 'pr' || !document.branch || !document.pullRequest || document.error)) {
      errors.push(fail('MALFORMED_RESULT', 'pr_published requires PR mode, branch and pullRequest'));
    }
    if ((document.outcome === 'retryable_failure' || document.outcome === 'blocked') && !document.error) {
      errors.push(fail('MALFORMED_RESULT', 'unsuccessful results require a structured error'));
    }
    if (document.error && (document.retryable !== (document.error.classification === 'retryable')
      || document.outcome !== (document.retryable ? 'retryable_failure' : 'blocked'))) {
      errors.push(fail('MALFORMED_RESULT', 'outcome and retryable must agree with the structured error'));
    }
    if (document.pullRequest && document.mode !== 'pr') errors.push(fail('MALFORMED_RESULT', 'branch mode cannot return a pull request'));
  }
  return errors;
}

function validate(type, document) {
  const validateSchema = ajv.getSchema(schemaFor.get(type));
  assert.ok(validateSchema, 'schema registered for ' + type);
  if (!validateSchema(document)) {
    return { valid: false, errors: validateSchema.errors.map((error) => ({ source: 'schema', keyword: error.keyword, instancePath: error.instancePath, params: error.params })) };
  }
  const errors = semanticErrors(type, document);
  return { valid: errors.length === 0, errors };
}

async function jsonFiles(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => ({ name, document: JSON.parse(await readFile(path.join(directory, name), 'utf8')) })));
}

test('all v1 schemas use JSON Schema Draft 2020-12 and have unique identifiers', () => {
  assert.equal(schemas.length, 5);
  assert.ok(schemas.every((schema) => schema.$schema === 'https://json-schema.org/draft/2020-12/schema'));
  assert.equal(new Set(schemas.map((schema) => schema.$id)).size, schemas.length);
  const requestSchema = schemas.find((schema) => schema.$id === schemaFor.get('publication-request'));
  assert.equal(requestSchema.properties.mode.default, 'pr');
  assert.ok(requestSchema.required.includes('mode'), 'Kirisame still requires an explicit publication operation');
});

test('valid contract fixtures are accepted', async (t) => {
  const fixtures = await jsonFiles(validDir);
  assert.ok(fixtures.length >= 7, 'valid fixture suite should cover requests, artifacts, results, and events');
  for (const { name, document } of fixtures) {
    await t.test(name, () => {
      const result = validate(document.documentType, document.value);
      assert.deepEqual(result, { valid: true, errors: [] });
    });
  }
});

test('invalid fixtures fail for their expected schema or semantic reason', async (t) => {
  const manifest = JSON.parse(await readFile(path.join(invalidDir, 'index.json'), 'utf8'));
  for (const entry of manifest.fixtures) {
    await t.test(entry.file, async () => {
      const fixture = JSON.parse(await readFile(path.join(invalidDir, entry.file), 'utf8'));
      const result = validate(fixture.documentType, fixture.value);
      assert.equal(result.valid, false, 'fixture must be rejected');
      assert.ok(result.errors.some((error) => error.source === entry.expected.source
        && (entry.expected.source === 'schema'
          ? error.keyword === entry.expected.keyword
          : error.code === entry.expected.code)), JSON.stringify(result.errors));
    });
  }
});

test('unknown request fields fail closed', async () => {
  const fixture = JSON.parse(await readFile(path.join(invalidDir, 'unknown-security-field.json'), 'utf8'));
  const result = validate(fixture.documentType, fixture.value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.source === 'schema' && error.keyword === 'additionalProperties'));
});
