import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { nativeProviderCacheWriter } from "./native-provider-cache.js";

/** System tools only: never consult source-relative PATH or forward ambient credentials. */
export function nativeProviderExecutionContext(sourceRoot, output, commands) {
  const source = realpathSync(sourceRoot);
  const inside = (path) => { const rel = relative(source, path); return !rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
  const writer = nativeProviderCacheWriter(output, source);
  const cwd = realpathSync(output);
  if (inside(cwd)) throw new Error("Provider process working directory enters source root");
  const directories = [...new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].flatMap((path) => {
    try { const resolved = realpathSync(path); return !inside(resolved) && statSync(resolved).isDirectory() ? [resolved] : []; }
    catch { return []; }
  }))];
  const executables = {};
  for (const command of commands) {
    if (!["dnf", "tar", "unzip"].includes(command)) throw new Error("Unsupported provider acquisition tool");
    for (const directory of directories) {
      for (const name of command === "dnf" ? ["dnf", "dnf5"] : [command]) {
        try {
          const path = realpathSync(join(directory, name));
          accessSync(path, constants.X_OK);
          if (!inside(path) && statSync(path).isFile()) { executables[command] = path; break; }
        } catch { /* An unavailable system executable is not an acquisition tool. */ }
      }
      if (executables[command]) break;
    }
    if (!executables[command]) throw new Error(`Verified system ${command} executable unavailable`);
  }
  const home = writer.mkdir(".provider-process-home");
  const temporary = writer.mkdir(".provider-process-tmp");
  const cache = writer.mkdir(".provider-process-home/.cache");
  return { sourceRoot: source, cwd, executables,
    env: { PATH: directories.join(":"), HOME: home, TMPDIR: temporary, XDG_CACHE_HOME: cache, LANG: "C", LC_ALL: "C" } };
}
