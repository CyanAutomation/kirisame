import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = path.join(root, "contracts/v1");
const schemaFiles = [
  "publication-artifact.schema.json",
  "publication-error.schema.json",
  "publication-event.schema.json",
  "publication-request.schema.json",
  "publication-result.schema.json",
];
const schemas = await Promise.all(schemaFiles.map(async (name) =>
  JSON.parse(await readFile(path.join(schemaDir, name), "utf8"))));
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true, code: { source: true, esm: true } });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);

const functions = {
  validateArtifact: schemas[0].$id,
  validateError: schemas[1].$id,
  validateEvent: schemas[2].$id,
  validateRequest: schemas[3].$id,
  validateResult: schemas[4].$id,
};
const portableFormats = `
function validateDateTime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?(Z|[+-](\\d{2}):(\\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0)
    && hour <= 23 && minute <= 59 && second <= 60
    && offsetHour <= 23 && offsetMinute <= 59;
}
function validateUri(value) {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol.length > 1; } catch { return false; }
}
`;
const output = standaloneCode(ajv, functions)
  .replace('"use strict";', portableFormats)
  .replaceAll('const func2 = require("ajv/dist/runtime/ucs2length").default;', "const func2 = (value) => Array.from(value).length;")
  .replaceAll('const formats0 = require("ajv-formats/dist/formats").fullFormats["date-time"];', "const formats0 = { validate: validateDateTime };")
  .replaceAll('const formats2 = require("ajv-formats/dist/formats").fullFormats.uri;', "const formats2 = validateUri;")
  .replaceAll('const func2 = ucs2lengthModule.default;', "const func2 = (value) => Array.from(value).length;")
  .replaceAll('const formats0 = ajvFormats.fullFormats["date-time"];', "const formats0 = { validate: validateDateTime };")
  .replaceAll('const formats2 = ajvFormats.fullFormats.uri;', "const formats2 = validateUri;");
await writeFile(path.join(root, "src/contracts/generated.js"), `${output}\n`);
