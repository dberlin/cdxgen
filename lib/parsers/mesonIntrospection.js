import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Read machine-produced Meson introspection with source AST callsites.
 * No wrap database lookup and no assumption that a declared fallback was used.
 */
export function parseMesonIntrospection({
  project,
  dependencies,
  options,
  machines,
  astFiles,
  log,
  sourceRoot,
  buildRoot,
}) {
  const requests = [];
  let hasDynamicDependency = false;
  const visit = (node, file) => {
    if (!node || typeof node !== "object") return;
    if (node.node === "FunctionNode" && node.name === "dependency") {
      const name = node.args?.positional?.[0];
      if (name?.node === "StringNode") {
        const kwargs = Object.fromEntries(
          (node.args.kwargs || []).map((kv) => [kv.key.value, kv.val]),
        );
        const versionNodes =
          kwargs.version?.node === "ArrayNode"
            ? kwargs.version.args.positional
            : undefined;
        const version =
          kwargs.version?.node === "StringNode"
            ? kwargs.version.value
            : versionNodes?.every((n) => n.node === "StringNode")
              ? JSON.stringify(versionNodes.map((n) => n.value))
              : kwargs.version
                ? "<unresolved-expression>"
                : "";
        const fallback =
          kwargs.fallback?.node === "ArrayNode"
            ? kwargs.fallback.args.positional.map((n) =>
                n.node === "StringNode" ? n.value : null,
              )
            : [];
        requests.push({
          consumer: { file, line: node.lineno, command: "dependency" },
          request: {
            name: name.value,
            constraints: version,
            arguments: [name.value],
          },
          fallback,
        });
      } else {
        // A name-only native log can belong to this unknown call rather than
        // any apparently unique literal (including a dormant literal).
        hasDynamicDependency = true;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child, file);
      else if (value && typeof value === "object") visit(value, file);
    }
  };
  for (const [file, ast] of astFiles) visit(ast, file);
  const counts = new Map();
  for (const row of requests)
    counts.set(row.request.name, (counts.get(row.request.name) || 0) + 1);
  const records = [];
  const unknown = (row, provider = {}) => ({
    consumer: row.consumer,
    request: row.request,
    applicability: "unknown",
    provider: {
      name: row.request.name,
      configuration: buildRoot,
      artifacts: [],
      ...provider,
    },
    evidence: [],
  });
  for (const row of requests) {
    // Logs lack executed-callsite proof. Unknown names can compete with every
    // literal, just as repeated literal names compete with each other.
    if (hasDynamicDependency || counts.get(row.request.name) !== 1) {
      records.push(unknown(row));
      continue;
    }
    const fallback = log.split(/\r?\n/).flatMap((line) => {
      const match =
        /^Dependency (\S+) for host machine from subproject (\S+) found: YES(?: (\S+))?\s*$/.exec(
          line.trim(),
        );
      return match && match[1] === row.request.name
        ? [{ source: match[2], version: match[3] }]
        : [];
    });
    if (fallback.length === 1) {
      const observed = fallback[0];
      const providerName = observed.source.split("/").at(-1);
      const selectedProject = project.subprojects?.find(
        (p) => p.name === providerName,
      );
      if (!selectedProject || row.fallback[0] !== providerName) {
        records.push(unknown(row));
        continue;
      }
      records.push({
        consumer: row.consumer,
        request: row.request,
        applicability: "selected",
        provider: {
          name: providerName,
          source: `${sourceRoot}/${observed.source}`,
          configuration: buildRoot,
          artifacts: [],
        },
        ...(observed.version && observed.version !== "undefined"
          ? { observedVersion: { value: observed.version, kind: "release" } }
          : {}),
        evidence: [],
      });
      continue;
    }
    const external = dependencies.filter((d) => d.name === row.request.name);
    if (external.length === 1) {
      const dependency = external[0];
      // Intro proves configuration, but does not identify the actual provider
      // .pc/config/header inputs. Do not accept stale or foreign metadata as a
      // provider version without that provenance.
      records.push(
        unknown(row, {
          type: dependency.type,
          artifacts: dependency.sources || [],
        }),
      );
    } else records.push(unknown(row));
  }
  return {
    records,
    targetProfile: {
      machines,
      options: options.map(({ name, value, machine }) => ({
        name,
        value,
        machine,
      })),
    },
  };
}

/** Check only observed source-file inputs; never execute Meson expressions. */
export function hasUnboundMesonVersionInputs(astFiles, sourceRoot, provider) {
  const within = (file) => {
    const path = relative(provider.root, file);
    return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
  };
  const unsupported = (node, file) => {
    if (!node || typeof node !== "object") return false;
    if (node.node === "FunctionNode" && node.name === "run_command")
      return true;
    if (node.node === "MethodNode" && node.name === "read") {
      const argument = node.args?.positional?.[0];
      if (argument?.node !== "StringNode") return true;
      const input = resolve(dirname(join(sourceRoot, file)), argument.value);
      if (!within(input) || !provider.files.includes(input)) return true;
    }
    return Object.values(node).some((value) =>
      Array.isArray(value)
        ? value.some((child) => unsupported(child, file))
        : value && typeof value === "object" && unsupported(value, file),
    );
  };
  return astFiles.some(
    ([file, ast]) => within(join(sourceRoot, file)) && unsupported(ast, file),
  );
}
