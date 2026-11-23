import { trimComponents } from "./depsUtils.js";

function containsIdentity(component, ref, seen = new Set()) {
  if (seen.has(component)) return true;
  if (component["bom-ref"] === ref) return true;
  seen.add(component);
  const found = (component.components || []).some((child) => containsIdentity(child, ref, seen));
  seen.delete(component);
  return found;
}

function unionValues(first = [], second = []) {
  const seen = new Set(first.map((value) => JSON.stringify(value)));
  return [...first, ...second.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}

/** Merge two declarations, retaining the caller-selected source/role owner.
 * A manifest's application classification wins over its lockfile library view
 * because callers retain the actual source hierarchy, not discovery order.
 * Existing descriptive/license-expression rules remain those of trimComponents.
 */
export function mergeComponentDeclaration(target, incoming) {
  for (const key of ["bom-ref", "purl", "name", "group", "version"]) {
    if ((target[key] || "") !== (incoming[key] || "")) {
      throw new Error(`Conflicting component declarations for ${target["bom-ref"]}: ${key}`);
    }
  }
  if (target === incoming) return target;
  const children = [...(target.components || []), ...(incoming.components || [])];
  if (children.some((child) => containsIdentity(child, target["bom-ref"]))) {
    throw new Error(`Component declaration merge would create a containment cycle: ${target["bom-ref"]}`);
  }
  const tags = unionValues(target.tags, incoming.tags);
  const occurrences = unionValues(target.evidence?.occurrences, incoming.evidence?.occurrences);
  const frames = unionValues(target.evidence?.callstack?.frames, incoming.evidence?.callstack?.frames);
  trimComponents([target, incoming]);
  if (tags.length) target.tags = tags;
  if (occurrences.length || frames.length) {
    target.evidence ||= {};
    if (occurrences.length) target.evidence.occurrences = occurrences;
    if (frames.length) target.evidence.callstack = { ...target.evidence.callstack, frames };
  }
  if (children.length) {
    const byRef = new Map();
    target.components = [];
    for (const child of children) {
      const ref = child["bom-ref"];
      if (ref && byRef.has(ref)) mergeComponentDeclaration(byRef.get(ref), child);
      else { if (ref) byRef.set(ref, child); target.components.push(child); }
    }
  }
  return target;
}

/** Define source components once in their existing hierarchy, merging the
 * complementary top-level lock/dependency sightings into those declarations.
 * References and dependency edges remain unchanged: the canonical ID is kept.
 */
export function dedupeHierarchyComponents(components, parentComponent) {
  const nested = new Map();
  const owners = new Map();
  const register = (component, owner, ancestors = new Set()) => {
    const ref = component["bom-ref"];
    if (ancestors.has(component) || (ref && ancestors.has(ref))) throw new Error("Component hierarchy contains a cycle");
    const ownerKey = owner?.["bom-ref"] || owner;
    const existing = ref && nested.get(ref);
    if (existing && owners.get(ref) !== ownerKey) throw new Error(`Component has multiple hierarchy owners: ${ref}`);
    if (ref && !existing) { nested.set(ref, component); owners.set(ref, ownerKey); }
    const next = new Set(ancestors).add(component);
    if (ref) next.add(ref);
    if (component.components) {
      component.components = [...new Set(component.components.map((child) => register(child, component, next)))];
    }
    if (existing) return mergeComponentDeclaration(existing, component);
    return component;
  };
  if (parentComponent) register(parentComponent);
  for (const component of components || []) {
    const ancestors = new Set([component]);
    if (component["bom-ref"]) ancestors.add(component["bom-ref"]);
    if (component.components) {
      component.components = [...new Set(component.components.map((child) => register(child, component, ancestors)))];
    }
  }
  const retained = [];
  const top = new Map();
  for (const component of components || []) {
    const ref = component["bom-ref"];
    const existing = ref && (nested.get(ref) || top.get(ref));
    if (existing) mergeComponentDeclaration(existing, component);
    else {
      retained.push(component);
      if (ref) top.set(ref, component);
    }
  }
  return retained;
}
