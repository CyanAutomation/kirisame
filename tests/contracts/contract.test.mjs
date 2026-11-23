import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateContract, validateResultAgainstRequest } from '../../src/contracts/validate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const schemaDir = path.join(root, 'contracts/v1');
const validDir = path.join(here, 'valid');
const invalidDir = path.join(here, 'invalid');
const schemaFiles = [
  'publication-artifact.schema.json',
  'publication-error.schema.json',
  'publication-event.schema.json',
  'publication-request.schema.json',
  'publication-result.schema.json',
];

async function jsonFiles(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => ({ name, document: JSON.parse(await readFile(path.join(directory, name), 'utf8')) })));
}

async function fixture(directory, name) {
  return JSON.parse(await readFile(path.join(directory, name), 'utf8'));
}

test('all v1 schemas use JSON Schema Draft 2020-12 and unique identifiers', async () => {
  const schemas = await Promise.all(schemaFiles.map(async (name) => JSON.parse(await readFile(path.join(schemaDir, name), 'utf8'))));
  assert.equal(schemas.length, 5);
  assert.ok(schemas.every((schema) => schema.$schema === 'https://json-schema.org/draft/2020-12/schema'));
  assert.equal(new Set(schemas.map((schema) => schema.$id)).size, schemas.length);
  const requestSchema = schemas.find((schema) => schema.$id.endsWith('/publication-request.schema.json'));
  assert.equal(requestSchema.properties.mode.default, 'pr');
  assert.ok(requestSchema.required.includes('mode'), 'Kirisame still requires an explicit publication operation');
});

test('valid contract fixtures are accepted by the runtime validator', async (t) => {
  const fixtures = await jsonFiles(validDir);
  assert.ok(fixtures.length >= 7, 'valid fixture suite covers requests, artifacts, results, and events');
  for (const { name, document } of fixtures) {
    await t.test(name, async () => {
      assert.deepEqual(await validateContract(document.documentType, document.value), { valid: true, errors: [] });
    });
  }
});

test('decoded artifact byte totals retain the Phase 0 regression check', async () => {
  const item = await fixture(validDir, 'artifact-add-modify-delete.json');
  item.value.files[0].content.data = btoa('shorter content');
  const result = await validateContract(item.documentType, item.value);
  assert.ok(result.errors.some((error) => error.code === 'TOTAL_BYTES_MISMATCH'));
});

test('invalid fixtures fail for their expected schema or semantic reason', async (t) => {
  const manifest = await fixture(invalidDir, 'index.json');
  for (const entry of manifest.fixtures) {
    await t.test(entry.file, async () => {
      const item = await fixture(invalidDir, entry.file);
      const result = await validateContract(item.documentType, item.value);
      assert.equal(result.valid, false, 'fixture must be rejected');
      assert.ok(result.errors.some((error) => error.source === entry.expected.source
        && (entry.expected.source === 'schema'
          ? error.keyword === entry.expected.keyword
          : error.code === entry.expected.code)), JSON.stringify(result.errors));
    });
  }
});

test('unknown request fields fail closed', async () => {
  const item = await fixture(invalidDir, 'unknown-security-field.json');
  const result = await validateContract(item.documentType, item.value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.source === 'schema' && error.keyword === 'additionalProperties'));
});

test('publication mode is required even though the schema documents the pr caller default', async () => {
  const item = await fixture(validDir, 'branch-publication-request.json');
  delete item.value.mode;
  const result = await validateContract(item.documentType, item.value);
  assert.ok(result.errors.some((error) => error.source === 'schema' && error.keyword === 'required'));
});

test('nested publication errors must agree with the stable error taxonomy', async () => {
  const item = await fixture(validDir, 'recoverable-publication-failure.json');
  item.value.error.classification = 'policy';
  const result = await validateContract(item.documentType, item.value);
  assert.ok(result.errors.some((error) => error.code === 'ERROR_CLASSIFICATION_MISMATCH'));
});

test('the production-unavailable error is valid under the v1 error contract', async () => {
  const result = await validateContract('publication-error', {
    code: 'PUBLISHING_UNAVAILABLE',
    classification: 'internal',
    message: 'GitHub publishing is not enabled in this deployment.',
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('lifecycle event type and state combinations are constrained', async () => {
  const item = await fixture(validDir, 'publication-event.json');
  item.value.type = 'publication.pull_request_created';
  item.value.state = 'retryable_failure';
  const result = await validateContract(item.documentType, item.value);
  assert.ok(result.errors.some((error) => error.code === 'INVALID_EVENT_TRANSITION'));
});

test('artifact validation rejects GitHub Actions workflow changes', async () => {
  const item = await fixture(validDir, 'artifact-add-modify-delete.json');
  item.value.files[0].path = '.github/workflows/release.yml';
  item.value.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const result = await validateContract(item.documentType, item.value);
  assert.ok(result.errors.some((error) => error.code === 'UNSUPPORTED_WORKFLOW_PATH'));
});

test('non-canonical base64 padding and unsafe Unicode paths fail', async () => {
  const item = await fixture(validDir, 'artifact-add-modify-delete.json');
  item.value.files[0].content.data = 'Zh==';
  item.value.files[0].path = 'release\u202e.txt';
  const result = await validateContract(item.documentType, item.value);
  assert.ok(result.errors.some((error) => error.code === 'INVALID_BASE64'));
  assert.ok(result.errors.some((error) => error.code === 'UNSAFE_PATH'));
});

test('artifact paths reject case-insensitive duplicates and file-directory collisions', async (t) => {
  await t.test('case-insensitive duplicate paths', async () => {
    const item = await fixture(validDir, 'artifact-add-modify-delete.json');
    item.value.files[1].path = 'readme.md';
    item.value.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

    const result = await validateContract(item.documentType, item.value);
    assert.ok(result.errors.some((error) => error.code === 'DUPLICATE_OR_CONFLICTING_PATH'));
  });

  await t.test('a file cannot also be a parent directory', async () => {
    const item = await fixture(validDir, 'artifact-add-modify-delete.json');
    const parent = structuredClone(item.value.files[0]);
    const child = structuredClone(item.value.files[0]);
    parent.path = 'config';
    child.path = 'config/settings.json';
    item.value.files = [parent, child];
    item.value.fileCount = item.value.files.length;
    item.value.totalBytes = item.value.files.reduce((total, file) => total + file.content.byteLength, 0);

    const result = await validateContract(item.documentType, item.value);
    assert.ok(result.errors.some((error) => error.code === 'DUPLICATE_OR_CONFLICTING_PATH'));
  });
});

test('decoded file size is enforced independently from the declared byte length', async () => {
  const item = await fixture(validDir, 'artifact-add-modify-delete.json');
  const file = item.value.files[0];
  file.content.byteLength = 1024 * 1024;
  file.content.data = 'A'.repeat(1_398_104);
  const result = await validateContract(item.documentType, item.value);
  assert.ok(result.errors.some((error) => error.code === 'FILE_TOO_LARGE'));
});

test('results must match the authorized request identity, repository and branch', async () => {
  const request = await fixture(validDir, 'branch-publication-request.json');
  const result = await fixture(validDir, 'successful-branch-result.json');
  assert.deepEqual(await validateResultAgainstRequest(request.value, result.value), []);

  result.value.repository.name = 'other-repository';
  result.value.branch.ref = 'kirisame/p/019a6000-0000-7000-8000-000000000099';
  const errors = await validateResultAgainstRequest(request.value, result.value);
  assert.ok(errors.some((error) => error.code === 'RESULT_REQUEST_MISMATCH'));
  assert.ok(errors.some((error) => error.code === 'RESULT_BRANCH_MISMATCH'));
});

test('a PR result with retryability from the wrong nested error is rejected', async () => {
  const item = await fixture(validDir, 'recoverable-publication-failure.json');
  item.value.retryable = false;
  item.value.error.classification = 'conflict';
  const result = await validateContract(item.documentType, item.value);
  assert.ok(result.errors.some((error) => error.code === 'ERROR_CLASSIFICATION_MISMATCH'));
  assert.ok(result.errors.some((error) => error.code === 'MALFORMED_RESULT'));
});
