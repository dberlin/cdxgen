import { resolveNativeAvailableProviders } from "./nativeAvailableProviders.js";
import { reconcileNativeSourceProviders } from "./nativeSourceVersions.js";

const REQUIREMENT = "cdx:build:requirement";
const stable = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

function requirementKey(property) {
  try {
    const record = JSON.parse(property.value);
    const { providerCandidates: _candidates, ...identity } = record;
    return stable(identity);
  } catch { return `raw:${property.value}`; }
}

function residualRequirements(components) {
  const residuals = new Map();
  for (const component of components) {
    if (component.version || !component["bom-ref"]) continue;
    const records = residuals.get(component["bom-ref"]) || new Set();
    for (const property of component.properties || []) if (property.name === REQUIREMENT) records.add(requirementKey(property));
    residuals.set(component["bom-ref"], records);
  }
  return residuals;
}

/** Combine independent resolutions of the same original occurrences. A request
 * remains unresolved only when every pass leaves it unresolved. Never merge
 * versioned components by ref here: canonicalization must first distinguish
 * material artifact variants that happen to share an incoming ref. */
export function mergeNativeProviderResolutions(originalUnresolved, dependencies, resolutions) {
  const residuals = resolutions.map((result) => result.residuals || residualRequirements(result.pkgList));
  const originalRefs = new Set(originalUnresolved.map((component) => component["bom-ref"]).filter(Boolean));
  const remap = new Map();
  for (const result of resolutions) for (const [ref, targets] of result.remap || result.refMap || []) {
    if (!originalRefs.has(ref)) remap.set(ref, [...new Set([...(remap.get(ref) || []), ...targets])]);
  }
  const pkgList = [];
  const seen = new Set();
  const keep = (component) => { if (!seen.has(component)) { seen.add(component); pkgList.push(component); } };
  for (const result of resolutions) for (const component of result.pkgList) {
    if (remap.has(component["bom-ref"]) && !remap.get(component["bom-ref"]).includes(component["bom-ref"])) continue;
    if (component.version || !originalRefs.has(component["bom-ref"])) keep(component);
  }
  const retainedRefs = new Set();
  for (const component of originalUnresolved) {
    const ref = component["bom-ref"];
    if (!ref) { keep(component); continue; }
    const records = (component.properties || []).filter((property) => property.name === REQUIREMENT);
    const unbound = records.filter((property) => residuals.every((pass, index) => {
      const targets = (resolutions[index].remap || resolutions[index].refMap)?.get(ref) || [];
      return !targets.some((target) => target !== ref) || pass.get(ref)?.has(requirementKey(property));
    }));
    const remains = records.length ? unbound.length > 0 : residuals.every((pass) => pass.has(ref));
    if (remains) {
      retainedRefs.add(ref);
      keep(unbound.length === records.length ? component : {
        ...component, properties: [...(component.properties || []).filter((property) => property.name !== REQUIREMENT), ...unbound],
      });
    }
  }
  for (const ref of originalRefs) {
    const replacements = new Set();
    for (const result of resolutions) for (const target of (result.remap || result.refMap)?.get(ref) || []) {
      if (target !== ref || retainedRefs.has(ref)) replacements.add(target);
    }
    if (retainedRefs.has(ref)) replacements.add(ref);
    if (replacements.size && (replacements.size !== 1 || !replacements.has(ref))) remap.set(ref, [...replacements]);
  }
  const resolveRefs = (ref, visited = new Set()) => {
    if (!remap.has(ref) || visited.has(ref)) return [ref];
    const next = new Set(visited).add(ref);
    return [...new Set(remap.get(ref).flatMap((target) => target === ref ? [ref] : resolveRefs(target, next)))];
  };
  for (const ref of remap.keys()) remap.set(ref, resolveRefs(ref));
  const refsOf = (ref) => remap.get(ref) || [ref];
  const retainedProviderRefs = new Set(pkgList.filter((component) =>
    component.version && !originalRefs.has(component["bom-ref"]) &&
    remap.get(component["bom-ref"])?.includes(component["bom-ref"])).map((component) => component["bom-ref"]));
  const graph = new Map();
  for (const edge of [...dependencies, ...resolutions.flatMap((result) => result.dependencies || [])]) {
    for (const ref of retainedProviderRefs.has(edge.ref) ? [edge.ref] : refsOf(edge.ref)) {
      const current = graph.get(ref) || { ...edge, ref, dependsOn: [], ...(edge.provides ? { provides: [] } : {}) };
      current.dependsOn = [...new Set([...current.dependsOn, ...(edge.dependsOn || []).flatMap(refsOf)])].filter((value) => value !== ref);
      if (edge.provides) current.provides = [...new Set([...(current.provides || []), ...edge.provides.flatMap(refsOf)])].filter((value) => value !== ref);
      graph.set(ref, current);
    }
  }
  // Incoming requirement edges may gain alternatives, but an existing provider's
  // own identity, candidate kind, and private dependencies do not change.
  for (const ref of retainedProviderRefs) remap.delete(ref);
  return { pkgList, dependencies: [...graph.values()], remap };
}

/** Both resolvers see the original requirements, so opting into external probes
 * cannot consume an occurrence before its checked-out alternatives are found. */
export function resolveNativeProviderAlternatives(pkgList, dependencies, sourceRoot, options = {}) {
  const originalUnresolved = pkgList.filter((component) => !component.version)
    .map((component) => ({ ...component, properties: [...(component.properties || [])] }));
  const available = resolveNativeAvailableProviders(sourceRoot, pkgList, dependencies, options);
  available.residuals = residualRequirements(available.pkgList);
  const originalObjects = new Set(pkgList);
  const sourceInputs = pkgList.concat(available.pkgList.filter((component) => component.version && !originalObjects.has(component)));
  const source = reconcileNativeSourceProviders(sourceInputs, dependencies, sourceRoot, options);
  return { ...mergeNativeProviderResolutions(originalUnresolved, dependencies, [available, source]),
    parentComponent: source.parentComponent || options.parentComponent,
    updatedRequirements: source.updatedRequirements, occurrenceRemapOverrides: source.occurrenceRemapOverrides };
}
