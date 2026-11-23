const DEFAULT_HOSTS = ["github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "gitlab.com", "gitlab.freedesktop.org", "sourceforge.net", "downloads.sourceforge.net", "sourceware.org", "www.mirrorservice.org", "www.python.org", "pypi.org", "files.pythonhosted.org", "www.fftw.org", "wrapdb.mesonbuild.com", "mesonbuild.com", "developer.download.nvidia.com", "docs.nvidia.com", "archives.fedoraproject.org", "download.fedoraproject.org", "dl.fedoraproject.org", "deb.debian.org", "gpuopen.com"];

/** Operator-supplied hostnames are exact, including every redirect destination. */
export function nativeAcquisitionUrl(value, allowedHosts) {
  const url = new URL(value);
  const hosts = allowedHosts === undefined ? DEFAULT_HOSTS : Array.isArray(allowedHosts) ? allowedHosts : String(allowedHosts).split(",");
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash ||
    !hosts.some((host) => host.trim().toLowerCase() === url.hostname)) throw new Error(`Unapproved native acquisition host: ${url.hostname}`);
  return url;
}

export function nativeAcquisitionRemaining(deadline, maximum = 30000) {
  const remaining = Math.min(maximum, deadline - Date.now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Native acquisition deadline exceeded");
  return Math.max(1, Math.floor(remaining));
}

export async function fetchNativeAcquisitionBytes(value, { allowedHosts, deadline = Date.now() + 300000, maximum = 64 * 1024 * 1024 } = {}) {
  let url = nativeAcquisitionUrl(value, allowedHosts);
  const redirectChain = [url.href];
  for (let redirects = 0; redirects <= 5; redirects++) {
    const remaining = nativeAcquisitionRemaining(deadline);
    const response = await fetch(url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(remaining) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); await response.body?.cancel();
      if (!location) throw new Error("Native acquisition redirect lacks Location");
      url = nativeAcquisitionUrl(new URL(location, url), allowedHosts); redirectChain.push(url.href); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Native acquisition HTTP ${response.status}`); }
    if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new Error("Native acquisition exceeds byte limit"); }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body || []) {
      nativeAcquisitionRemaining(deadline);
      bytes += chunk.byteLength;
      if (bytes > maximum) { await response.body?.cancel().catch(() => {}); throw new Error("Native acquisition exceeds byte limit"); }
      chunks.push(chunk);
    }
    nativeAcquisitionRemaining(deadline);
    return { bytes: Buffer.concat(chunks, bytes), resolvedUrl: url.href, redirectChain };
  }
  throw new Error("Native acquisition redirect limit exceeded");
}
