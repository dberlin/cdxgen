import { createHash } from "node:crypto";

export const NATIVE_REQUIREMENT_PROPERTY = "cdx:build:requirement";
export const NATIVE_REQUIREMENT_LINK_PROPERTY = "cdx:build:requirementLink";
export const NATIVE_REQUIREMENT_TABLE_PROPERTY = "cdx:build:requirementTable";
export const NATIVE_REQUIREMENT_ENTRY_PREFIX = `${NATIVE_REQUIREMENT_TABLE_PROPERTY}:`;

export function isSharedNativeRequirementProperty(name) {
  return name === NATIVE_REQUIREMENT_LINK_PROPERTY || name === NATIVE_REQUIREMENT_TABLE_PROPERTY ||
    typeof name === "string" && name.startsWith(NATIVE_REQUIREMENT_ENTRY_PREFIX);
}

export function assertNativeRequirementMetadataOptions(options) {
  if (options.nativeEvidenceFormat !== "shared") return;
  const property = options.metadataProperties?.find((entry) => isSharedNativeRequirementProperty(entry?.name));
  if (property) throw new Error(`Shared native evidence reserves the metadata property '${property.name}'`);
}

const schema = "1";
const validId = /^sha256:[0-9a-f]{64}$/;
const evidenceId = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

// A nonstandard attachment may carry information beyond its value, even
// down to the ordering of its fields. Leave it alone instead of normalizing it.
function attachmentValue(property) {
  if (Object.getPrototypeOf(property) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(property);
  if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "value") return undefined;
  const name = Object.getOwnPropertyDescriptor(property, "name");
  const value = Object.getOwnPropertyDescriptor(property, "value");
  return name.enumerable && typeof name.value === "string" && value.enumerable && typeof value.value === "string" ? value.value : undefined;
}

function validEvidence(value) {
  if (typeof value !== "string" || !value.isWellFormed()) return false;
  try {
    const decoded = JSON.parse(value);
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded);
  } catch {
    return false;
  }
}

/**
 * Replace repeated, standard inline requirement attachments in place. The
 * caller provides the final mutable property arrays; holders and property
 * objects are never mutated, and a shared array is visited only once. Append
 * `tableProperties` to BOM metadata properties before serialization.
 */
export function packNativeRequirementEvidence(holders) {
  const arrays = new Set();
  const values = new Map();
  const groups = new WeakMap();
  for (const holder of holders) {
    const properties = holder?.properties;
    if (!Array.isArray(properties) || arrays.has(properties)) continue;
    arrays.add(properties);
    for (const property of properties) {
      if (property?.name === NATIVE_REQUIREMENT_LINK_PROPERTY) throw new Error("Native requirement evidence is already linked");
      if (property?.name !== NATIVE_REQUIREMENT_PROPERTY) continue;
      let group = groups.get(property);
      if (group === undefined) {
        const value = attachmentValue(property);
        if (value === undefined) { groups.set(property, null); continue; }
        group = values.get(value);
        if (!group) {
          group = { count: 0, id: undefined };
          values.set(value, group);
        }
        groups.set(property, group);
      }
      if (group) group.count++;
    }
  }

  const tableProperties = [];
  const ids = new Set();
  for (const [value, group] of values) {
    if (group.count < 2 || !validEvidence(value)) continue;
    const id = evidenceId(value);
    if (ids.has(id)) throw new Error(`Native requirement evidence digest conflict for ${id}`);
    ids.add(id);
    group.id = id;
    if (!tableProperties.length) tableProperties.push({ name: NATIVE_REQUIREMENT_TABLE_PROPERTY, value: schema });
    tableProperties.push({ name: `${NATIVE_REQUIREMENT_ENTRY_PREFIX}${id}`, value });
  }

  let packedAttachments = 0;
  if (ids.size) for (const properties of arrays) {
    for (let i = 0; i < properties.length; i++) {
      const id = groups.get(properties[i])?.id;
      if (!id) continue;
      properties[i] = { name: NATIVE_REQUIREMENT_LINK_PROPERTY, value: id };
      packedAttachments++;
    }
  }
  return { tableProperties, packedAttachments, uniqueValues: ids.size };
}

/**
 * Validate dictionary metadata and restore ordinary requirement properties.
 * Multiple BOM fragments may contribute identical schema markers or rows.
 * Invalid schema, invalid/mismatched rows and dangling links throw rather
 * than losing occurrences. Legacy inline and unrelated properties pass through.
 */
export function createNativeRequirementEvidenceIndex(metadataProperties = []) {
  const entries = new Map();
  let hasSchema = false;
  for (const property of metadataProperties) {
    const name = property?.name;
    if (name === NATIVE_REQUIREMENT_TABLE_PROPERTY) {
      if (attachmentValue(property) !== schema) throw new Error("Invalid native requirement evidence table schema");
      hasSchema = true;
    } else if (typeof name === "string" && name.startsWith(NATIVE_REQUIREMENT_ENTRY_PREFIX)) {
      const id = name.slice(NATIVE_REQUIREMENT_ENTRY_PREFIX.length);
      const value = attachmentValue(property);
      if (!validId.test(id) || value === undefined) throw new Error(`Invalid native requirement evidence table entry ${id}`);
      const previous = entries.get(id);
      if (previous !== undefined && previous !== value) throw new Error(`Conflicting native requirement evidence table entries for ${id}`);
      if (previous === undefined) entries.set(id, value);
    }
  }
  if (entries.size && !hasSchema) throw new Error("Missing native requirement evidence table schema");
  for (const [id, value] of entries) {
    if (!validEvidence(value)) throw new Error(`Invalid native requirement evidence value for ${id}`);
    if (evidenceId(value) !== id) throw new Error(`Native requirement evidence digest mismatch for ${id}`);
  }

  const resolveProperty = (property) => {
    if (property?.name !== NATIVE_REQUIREMENT_LINK_PROPERTY) return property;
    const id = attachmentValue(property);
    if (id === undefined || !validId.test(id)) throw new Error("Invalid native requirement evidence link");
    const value = entries.get(id);
    if (value === undefined) throw new Error(`Missing native requirement evidence entry ${id}`);
    return { name: NATIVE_REQUIREMENT_PROPERTY, value };
  };
  const expandProperties = (properties) => {
    let expanded = properties;
    for (let i = 0; i < (properties?.length || 0); i++) {
      const property = properties[i];
      if (property?.name !== NATIVE_REQUIREMENT_LINK_PROPERTY) continue;
      if (expanded === properties) expanded = properties.slice();
      expanded[i] = resolveProperty(property);
    }
    return expanded;
  };
  return { resolveProperty, expandProperties };
}
