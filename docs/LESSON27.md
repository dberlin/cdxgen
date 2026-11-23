# Lesson 27 - C and C++ SBOMs with Conan, vcpkg, and meson

C and C++ are awkward ecosystems for SBOMs. There is no single lockfile that
describes the world. A project might use Conan, vcpkg, CMake `FetchContent`, git
submodules, meson WrapDB, or just vendor headers straight into the tree. cdxgen
handles all of these in one pass, but it pays to know which inputs it actually
reads and what it does with each.

This lesson walks through generating an SBOM for a C/C++ project, explains the
priority order cdxgen applies, and shows how to read the result.

## Goal

By the end of this lesson you should be able to:

1. Generate an SBOM for any C/C++ project with `cdxgen -t c++`.
2. Predict which files cdxgen will parse and which dependencies end up in the
   BOM.
3. Tell apart resolved dependencies, version requirements, and vendored code.
4. Wire a C/C++ SBOM step into CI.

## Learning Objective

Understand the C/C++ BOM lifecycle in cdxgen: what `createCppBom` reads, how
Conan, vcpkg, meson, and CMake contribute, and how to interpret the resulting
purls and properties.

## 1) The project type and what cdxgen parses

The project type alias is broad on purpose (see `PROJECT_TYPE_ALIASES` in
`lib/core/env.js`):

```
c: ["c", "cpp", "c++", "conan", "collider", "cmake", "meson", "vcpkg"]
```

Any of `c`, `cpp`, `c++`, `conan`, `collider`, `cmake`, `meson` or `vcpkg`
routes to `createCppBom` in
`lib/cli/nativeBom.js`. From one project root, cdxgen looks for all of these in a
single scan:

| File                                                         | Parser                        | What it contributes                                                               |
| ------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------- |
| `conan.lock`                                                 | `parseConanLockData`          | Resolved packages plus a dependency graph                                         |
| `conanfile.txt`                                              | `parseConanData`              | Flat requires/build_requires list, with scope                                     |
| `collider.lock`                                              | `parseColliderLockData`       | Resolved packages and graph                                                       |
| `CMakeLists.txt`, `*.cmake`                                  | `parseCmakeLikeFile`          | Parent project, `find_package` requirements, configure-time downloads             |
| `meson.build`                                                | `parseCmakeLikeFile`          | Parent project, `dependency()` declarations                                       |
| `vcpkg.json`                                                 | `getCppModules` (cppEvidence) | Parent project and declared dependencies                                          |
| `CMakeCache.txt`                                             | `resolveCmakeContext`         | Resolved versions, FetchContent pins, submodule pins                              |
| `CMakePresets.json`, `CMakeUserPresets.json`                 | `resolveCppBuildContext`      | Configure presets (formulation), and where the build trees are                    |
| `compile_commands.json`, `CMakeFiles/*/CMake*Compiler.cmake` | `resolveCppBuildContext`      | Compilers (formulation), hardening options, the project's own include directories |

There is a deliberate priority: Conan lock files come first because they carry
resolved versions and a real graph. If no lock exists, cdxgen falls back to
`conanfile.txt`. The CMake-like files are parsed afterwards and their entries are
collapsed separately so a `find_package` requirement never overwrites a resolved
Conan version.

Run it:

```bash
cdxgen -t c++ -o bom.json .
```

An explicit `-t c` (or `cpp`, `c++`) also runs include analysis with atom in
header mode; `--deep` switches it to a full parse with function bodies (see
step 6).

## 2) Conan support

`parseConanLockData` understands both Conan formats:

- **Conan 1.x** (`graph_lock.nodes`): every node with a `ref` becomes a
  component, and the `requires` / `build_requires` edges become the dependency
  graph. Node `0` is the parent project.
- **Conan 2.x** (`requires` map): each entry becomes a flat component. The
  `%recipe` suffix is stripped before building the purl.

Conan references are converted to `pkg:conan/...` purls. From a lockfile you get
versions and a tree:

```bash
jq '.components[] | select(.purl | startswith("pkg:conan")) | {name, version, purl}' bom.json
```

When only `conanfile.txt` is present, `parseConanData` reads the `[requires]`
and `[build_requires]` sections. The scope is set accordingly:

- `[requires]` -> `scope: required`
- `[build_requires]` -> `scope: optional`

This is a flat list with no graph, because `conanfile.txt` does not encode one.

Note that `conanfile.py` is not parsed directly. If your project uses the Python
form, export a `conan.lock` first (`conan lock create`) so cdxgen can read
resolved coordinates.

## 3) vcpkg support

cdxgen reads the vcpkg manifest, `vcpkg.json`, with `parseVcpkgManifest`
(`lib/ecosystems/cppEvidence.js`). The read runs no tool, so it happens in every
C/C++ scan, including an auto-detected one where the atom analysis of step 6 is
skipped. When present the manifest is treated as a strong hint about the parent
project and its direct dependencies:

- The manifest `name` and `version` become the parent component.
- Each entry in `dependencies[]` becomes a `generic` component. String entries
  and object entries with a `name` are both accepted. A dependency that declares
  `host: true` is tagged `scope: optional`.
- A port's version is the one vcpkg installed, read from
  `vcpkg_installed/vcpkg/info` in the project or a build directory, with its
  triplet in `cdx:vcpkg:triplet`. Without an installed tree, a version the
  manifest pins in `overrides` is used, marked `cdx:vcpkg:versionSource=override`;
  its `port-version` is a packaging revision and is kept apart in
  `cdx:vcpkg:portVersion`. A `version>=` constraint is only a lower bound, so it
  is recorded as `cdx:vcpkg:minimumVersion` and never becomes the version.

List the vcpkg-sourced components:

```bash
jq '.components[] | select(.evidence.identity.methods[0].value | endswith("vcpkg.json")) | .name' bom.json
```

## 4) Meson and the WrapDB

`meson.build` is parsed by the same `parseCmakeLikeFile` routine that handles
CMake. For meson it specifically recognises:

- `project(name, version: 'literal')` for the parent component. Expressions
  such as `files('VERSION')` remain unknown, not literal release strings.
- `dependency('foo', version: '...')` declarations. Minimums and ranges stay
  constraints. An explicit `==` exact version can identify a declared-exact
  component; it is not evidence of an installed or selected provider.

Catalog membership never selects a provider: a CMake `GLUT` request remains
`GLUT`, not `freeglut`, and `find_library(DESTINATION NAMES dl)` requests `dl`,
not the destination variable or the WrapDB alternative `dlfcn-win32`.
WrapDB and the owning project's `subprojects/*.wrap` files contribute
unselected provider candidates. Multiple wraps providing one name remain
separate alternatives, including wraps with nonnumeric source selectors.
Each local candidate's `source` preserves its scan-relative wrap `file` and
section `line`, wrap `type`, declared extraction `directory`, publishable source
`url`, archive `filename` and declared `provides` aliases when present. Valid
`source_hash` values are retained as SHA-256 `hashes`; a URL-encoded
release/source/archive revision is separately classified by `identity`. Git
wraps retain their declared `reference`, not a claim that a branch or tag is an
immutable commit. Distinct recipes/copies stay separate. An explicit literal
`fallback` identifies a candidate recipe even when it has no `[provide]` entry;
it does not select that recipe.
The declared `source_fallback_url` is retained as `source.fallbackUrl`, without
claiming the alternative was used. Separate `source.patch` metadata retains
`patch_filename`, `patch_url`, validated `patch_hash`, `patch_fallback_url`,
`patch_directory` and ordered comma-separated `diff_files` as `filename`,
`url`, SHA-256 `hashes`, `fallbackUrl`, `directory` and `diffFiles`. Patch
checksums never replace primary source checksums. URL publication uses the
same credential/query/fragment stripping and protocol guard as primary sources;
local patch/diff paths are literal data, never traversed, read or applied.
These fields describe recipe inputs, not evidence that patches were applied.
These source facts need no download, compiler or configured build. Concrete
recipe releases, declared release tags, immutable Git revisions and validated
archive checksums materialize actual versioned source components, with valid
PURLs and dependency edges. A checksum-only identity is classified as
`archive-hash`, not a release. Catalog entries and floating selectors without
an explicit cached snapshot do not invent versions. When explicit local recipes
provide concrete identities not excluded by a request's literal constraint,
the source-superset BOM carries that request and its original
constraints/provenance on every such versioned alternative,
instead of a duplicate unversioned request placeholder. Candidate references
remain `selected: false`; a recipe version is never treated as an observed
installed version or a dependency's minimum as its actual version.
Floating alternatives remain source-declaration metadata even beside known
versions; they do not require duplicate unknown software components.
Requests with no evidenced owner remain independent. In the final native-owner
pass, known owners do not wait for search roots, components, or version predicates
to become satisfied: the original occurrence moves to every evidenced owner,
retaining `originalBomRef`, its raw/evaluated arguments and explicit
`unknown`/`violated` candidate compatibility. An occurrence with no owner in a
merged component remains unresolved independently. This does not select a
provider or change configuration-scoped native facts.

For CMake `find_program`, a source owner can also provide a candidate through
an installed executable target or an owned `install(PROGRAMS)` input. The
owner's release identifies the source; declared output and install rules do
not establish that the executable was built, installed, or selected. Package
inventories can supply separate available tool owners by literal file
membership. Fedora RPM acquisition queries indexed executable paths for the
finder's literal names and alternatives, not guessed package names.

Every distinct local recipe also survives independently as a
`cdx:build:requirement` with role `source-declaration` and command `meson-wrap`,
owned by the project (or native metadata channel), even when no dependency
mentions it. Alias names do not duplicate a recipe's source declaration; its
exact wrap path distinguishes it from another copy.

Selected Meson providers require explicit, configuration-scoped native facts
captured from actual introspection, source ASTs and fallback-selection logs.
Source-only parsing never selects a provider from a nearby `build/` directory.
The observed dependency version can differ from the subproject's project
version; the dependency's own value is retained. A wrap recipe, catalog entry,
fallback policy or same-name project remains an unselected candidate.
Ambiguous repeated/dynamic calls, unbound external `.pc` ownership and
unsupported version inputs stay unresolved.

`cdx:build:requirement` properties retain JSON records with the requested name,
scan-relative caller file, line, source-statement ordinal, command, arguments,
constraints, conditions and provider candidates. Source declarations, destination variables, build targets, target
aliases and unresolved expressions keep their roles instead of becoming
software releases. ExternalProject archive/repository identities remain real
source dependencies; precision/scheduler labels are recorded separately, and
labels explicitly sharing a source directory retain their candidate source
relationships. Unresolved records also survive on the owning project, or in
`metadata.properties` when no native project is declared, including module-only
and generated-requirement-only aggregate scans.
Meson `arguments` retain raw top-level argument expressions, including quoted
commas and nested lists/calls. A complete quoted version constraint keeps its
decoded value; a variable or concatenation such as `'>=' + _drm_ver` stays the
whole unevaluated constraint expression, never a truncated `>=` or release.
A declared `SOURCE_DIR` remains a `source-declaration` requirement even when
that directory is absent. Its evaluated path, declaration line, conditions and
make-available intent survive with no provider candidates; no component is
invented and no similarly named sibling checkout is substituted.
Callsite scopes stay separate through provider resolution, including repeated
same-file requests with different constraints. An enclosing source project or
submodule is only an unselected candidate: name, ancestry and a compatible
version do not prove that `find_package` selected it instead of an installed
external provider. Actual provider evidence can bind independent callsites;
the owning source project's identity is not mutated merely by a request.
After resolution, remaining unresolved components may share a purl. Case-equivalent
purls use the first component retained by aggregate deduplication, preserving
every callsite record and remapping graph endpoints to that component's actual ref.

## 5) CMake: cache resolution and FetchContent

`CMakeLists.txt` scraping gives you `find_package` names and version
requirements, but not resolved versions. To resolve them, cdxgen reads the build
tree through `resolveCmakeContext` in `lib/ecosystems/cmakeResolver.js`. It looks
for `CMakeCache.txt` in the build directories the project's CMake presets
configure (see below), then in `build/`, `build-*/`, `out/`, `builddir/` and
`cmake-build-*/` at the root and one level below `build/`, `out/` and
`out/build/`, or at an explicit path you pass with `--cmake-cache`.

Repeated `find_package` / `find_dependency` constraints are all retained in
`cdx:cmake:versionRequirements`, including repeats within one file. Source
ancestry and a compatible version establish only a candidate, not provider
selection. The legacy name-only cache enrichment is restricted to one
unconditional scan-root callsite; explicit native facts disable that path,
including when the supplied facts are invalid.

Bounded local version evaluation follows command order. Each FetchContent,
ExternalProject or CPM declaration consumes its variable values at that point:
a later assignment or local version include cannot rewrite an earlier pin.
Supported `file(READ path variable)` reads remain bounded to local regular
files. READ options such as `OFFSET`, `LIMIT` and `HEX` are not interpreted;
they invalidate the destination instead of publishing the whole file as an
exact version.

Recursive evaluation reuses command-syntax summaries and completed variable-
dependency closures within one evaluation. These summaries contain no resolved
versions, helper bindings or file contents: each invocation still evaluates its
own variables, helper definitions, source owner, conditions and input files.
Helper arguments are bound in the callee's variable snapshot without an extra
copy of the caller's complete variable map. Unsupported build-target commands
still count against the same analysis budgets, but their unused argument lists
are not expanded unless their name resolves to a locally defined helper.
Conservative helper evaluation can also reuse completed summaries of a closed
helper graph that cannot read files or redefine helpers. These summaries key
actual inherited variable values and presence, helper definitions, source owner,
project name, needed inputs, template mode and recursion depth. Conditions and
invocation paths are stored relative to the caller and restored for every
observation; a hit consumes the original command cost and is used only when the
remaining budget permits the complete evaluation. Truncated evaluations and
helpers with transitive file reads are not memoized. Storage limits cause normal
evaluation, not missing declarations. Summaries live for one evaluation only.
There is no persistent version-result cache or change to branch/include budgets.

For automatic multi-ecosystem scans of a single read-only source snapshot,
`--immutable-source` reuses directory discovery across ecosystem patterns.
This is an operator assertion that the entire source tree remains unchanged
throughout the scan, not a flag that makes files read-only. Do not use it on
mutable build trees. Project configuration cannot enable it. The per-scan
directory cache retains at most 1,048,576 child entries and is released when
the scan completes or fails; larger trees can reread evicted entries without
losing matches. Glob patterns, exclusions, dotfile rules and result ordering
are unchanged. Multiple source roots remain uncached unless they are under
the existing extracted-container cache root.
The CLI also enables a separate cache for postprocessing discovery, including
formulation and README searches, under the same explicit single-root assertion.
That cache is cleared when postprocessing returns or throws.
Within each cached directory walk, string-array exclusions also reuse the
native glob ignore decisions for the same path and matching options. Separate
working directories and exclusion lists retain separate decisions; custom
ignore hooks remain uncached. Resetting the directory cache discards these
decisions too.
Observed Git revision and cleanliness evidence inside that immutable root can
also be retained across external probes instead of repeating recursive Git
checks. Reuse requires unchanged effective Git configuration, HEAD, actual
worktree/index paths and index contents across every observed checkout.
Changes or failures invalidate the observations, including cached parent
submodule checks. Split-index checkouts keep fresh-observation behavior.
Mutable sources still invalidate after source-writing commands, and every
new generation discards prior observations.

Native provider collection memoizes the nearest source-project boundary for
each manifest and indexes exact export identities instead of repeatedly
serializing earlier exports. Branch and helper environments share snapshots
until a binding changes; branch restoration does not copy every binding.
Joins retain undefined-binding cleanup and skip value comparisons only when
every outcome shares the current environment's unchanged storage. Other
joins avoid flattening whole environments into temporary arrays. These per-call
optimizations preserve manifest and export order, nested project ownership,
conditional evidence and evaluator budgets; they do not cache provider
results across scans.

Within each source owner, ordinary CMake functions can reuse a bounded summary
when their observed input bindings and evaluation context match. Summaries
replay parent-scope writes and the original logical command cost. Macros,
diagnostics, changed helper definitions and observable provider or control-stack
effects prevent reuse. Input matching distinguishes absent from empty values;
failed matches and unchanged-join bookkeeping do not introduce new variable
reads. Definition-graph changes discard obsolete summaries and reclaim their
capacity. Limits are checked after nested evaluation as well as before it;
reaching a limit disables additional caching, not analysis. Summaries are
discarded after the owner is evaluated and do not replace source evidence.

Repeated discovery contexts can also reuse a complete owner evaluation within
one collection call when their actual inputs match exactly: source directory,
scope, contracts, project identity/version kind and ordered variable bindings.
Different occurrence conditions or provenance do not require repeating that
evaluation, but every original fact is still filtered and registered in order.
Cached exports and metadata observations are privately cloned; Find metadata
writes and diagnostics are replayed without replacing other owners' state.
Ownership-boundary changes, new staging effects or unfinished control stacks
prevent reuse. Only repeated inputs are retained, and their cached results are
released after the last matching context. Nothing is reused across scans.

Authenticated provider exports are checked by exact serialized-value membership,
not a pairwise scan of the entire authenticated file inventory for every claim.
Membership sets are local to one collection and keyed by the authenticated
inventory identity. Normal claims and explicit unknown-interface claims retain
separate allowed values; property order, duplicate claims and output order are
unchanged, and no authentication result persists across scans.

Unsigned CLI JSON outputs are serialized in bounded chunks, including large
native inventories that exceed the runtime's single-string limit. File output
preserves exact-file write grants and existing file permissions; a failed direct
write can leave partial content. Standard output respects backpressure.
Signing still uses the existing whole-payload signing path and does not gain
the unsigned writer's large-document guarantee.

Source-version discovery separately reuses configured evaluations of the same
file with identical ordered string bindings. Only explicit contexts with
nonempty caller conditions qualify; unconfigured and unguarded evaluations
remain separate. Reused results are privately cloned and their validated caller
condition prefix is replaced, preserving local/helper conditions and independent
owned-metadata evidence. Every original context and registration remains present.
This cache is cleared between files and never persists across scans.

The CLI `--project-version` fallback applies only to a CMake/Meson project at
the scan root. Independent nested projects retain their own declared versions
or remain unresolved until source-owner reconciliation supplies evidence.
The scan's application version is not a dependency release or source revision.

Nonnumeric Git tags and branches retain their declared `cdx:cmake:gitRef`,
but are not asserted to be immutable source revisions or release versions.
Their purls carry a `vcs_url` source qualifier including the declared ref:
two selectors of the same repository therefore remain distinct components
with their own filename provenance. Identical pins may combine evidence.
Unexpanded or tainted variable expressions are not published as Git refs.

Conditional ExternalProject downloads retain explicit repository URLs and
literal fallback archive URLs even when a build-target name or prefix cannot
be resolved. These source declarations carry `cdx:cmake:conditional=true`;
literal fallbacks additionally carry `cdx:cmake:sourceRole=literal-fallback`
and `cdx:cmake:unresolvedUrlOverride=true` when an earlier override is unknown.
An archive's own URL-derived release describes that archive, not a library
that might be built from it. These declarations never satisfy unrelated
same-name package requirements. Source-only ExternalProject build targets
with no download location do not create software components for their labels.

The source-declaration pass also follows bounded local includes, list-valued
download arguments, and literal `add_subdirectory` ownership edges. Unknown
branches and unused helper definitions describe **candidates**, not executed
configuration: `cdx:cmake:conditions` preserves their scope. Archive defaults,
environment/cache overrides and hashes remain paired with their declaration;
an unrelated same-name checkout cannot replace that archive's identity.
Literal `file(DOWNLOAD ...)` locations are source artifacts, not evidence that
the downloaded script ran. Concrete `SOURCE_DIR` declarations can identify
the directory's own project, never the ExternalProject scheduler label.
Concrete conditional Git selectors are retained as separate declaration
alternatives with their complete conditions and unselected source-candidate
requirements; they do not identify an installed provider. Writes inside a
potentially empty loop remain unknown across local includes. Statically
inactive helper definitions do not contribute source declarations.
Bounded, closed data helpers can establish literal function `PARENT_SCOPE`
and macro outputs without executing project code. Statement-time writes and
deletions survive includes and split block/branch continuations; each conditional
alternative keeps its own bindings. Unsupported or budget-truncated effects
invalidate affected outputs rather than restoring a stale caller value.
Numeric captures require fully resolved input, including every concatenated
argument; a known prefix cannot establish a release when its suffix is unknown.
Speculative helper-body candidates share a separate fixed traversal budget,
so their exhaustion cannot erase the caller's declarations or output summaries.
Independent declaration-only branches retain their own conditions and share
one unchanged continuation, rather than multiplying unrelated source choices.
Branches with supported state effects or unrecognized commands keep full forks.
Two local `SOURCE_DIR` instances with the same owned release share their
honest package purl but retain distinct, validated source-instance `bom-ref`s;
directory provenance, not an unsupported purl qualifier, distinguishes them.


Owned version metadata can be read from explicit local header fields, JSON
keys, bounded `file(STRINGS)` version lines and numeric Make fields. Source
regexes are not executed: only supported literal field/capture forms are read.
`cdx:cmake:versionCandidate` JSON keeps project versions and exact
project-owned constants, setup versions, package constants, owned JSON
versions, helper arguments, library versions and SOVERSION values distinct,
with their source locations and conditions. JSON ownership can follow an
explicit parent-to-child `add_subdirectory` edge, not an unrelated sibling.
In particular a `get_version` argument is not automatically a package
release, and an ABI number is not a project version. These facts do not
select a provider for a `find_package` consumer.
The source-dependency inventory is a superset, not a selected-build report.
At an exact owned project/source directory it also records bounded static
`VERSION` literals or explicit major/minor/patch fields, and a literal
top-level `AC_INIT` in `configure.ac`/`configure.in` (at the root or `src`).
These `owned-version-file` / `owned-autoconf-init` facts retain their owner and
file/line. An unambiguous owned release now populates the source component's
`version`; its previous immutable identity remains in
`cdx:version:sourceRevision` and `cdx:version:sourceIdentity`. Bounded package
config exports identify available versioned package alternatives, not a
configured provider. Multiple evidenced alternatives remain distinct, and
matched requirements move onto them instead of duplicating unknown software.
No enclosing umbrella VERSION is copied to an unrelated child or same-name
consumer. Shell/M4 expressions, conflicting fields and nonregular or
out-of-root metadata are not evaluated.
One native `VERSION` discovery pattern reuses the existing file cache, including
directories without CMake/Meson manifests. Every such fact has an exact
scan-relative `ownerSourceDir`. An unambiguous multipart field prefix can name
its owner; a bare VERSION without a proven owner stays a path-qualified fact,
not a package guessed from the directory name. Root source owners and
parentless aggregate metadata use the same reader and ownership policy.

Fixed numeric `#define`/literal macro-argument MATCHES forms may supply
conditional `helper-output` candidates, but project regexes and macro bodies
are never compiled or executed. Explicit header reads are capped at 2 MiB;
other version reads remain capped at 256 KiB and VERSION files at 8 KiB.
Unknown helper outputs still invalidate caller bindings. Literal
`get_version_from_tag` arguments are `helper-default` candidates; a project's
own cached `<PROJECT>_RELEASE_VERSION` is a `packaging-default` with its variable
and callsite. Neither is asserted as the observed project/provider release.


An optional external exact-source cache supplies metadata from a selected
Git object without checking it out or configuring it:

```sh
bun contrib/native-source-cache.js --manifest /src/project/CMakeLists.txt \
  --source-root /src/project --cache /external/native-source-cache --fetch
CDXGEN_NATIVE_SOURCE_CACHE=/external/native-source-cache \
  bun bin/cdxgen.js -t c /src/project --no-install-deps -o /external/bom.json
```

The producer requires explicit `--fetch` permission (or `--git-dir` naming
an already available object repository). Network retrieval uses only fixed,
explicit GitHub HTTPS repositories. By default only full commits and tag refs
are accepted. `--resolve-floating` explicitly snapshots a declared branch at
its current full commit, recording the branch and observation time. It does
not make the original declaration reproducible or select that source for a
configured build. No repository hooks, checkout filters, submodules or source
code are executed.
All Git object reads disable replacement refs. The cache must be outside
every effective manifest source root and object repository, including the
worktree enclosing a `.git` directory. When using `--git-dir`, supply
`--source-root` explicitly; validation precedes any cache or network writes.
The passive generator never fetches or writes this cache. Cached metadata is
content-addressed, bounded and hash-checked; an absent, unsupported or changed
snapshot supplies no release. The object's own declared version, full
`cdx:source:revision`, original `cdx:cmake:gitRef` and
`cdx:version:kind` remain separate. Original selectors and source locations
remain provenance when equivalent discoveries converge on one package release.
Mutable declarations without an explicitly captured snapshot stay unresolved.
Snapshots are reused offline until the producer is explicitly run again;
the passive scan never refreshes a moving branch. `origin/NAME` is resolved
as `refs/heads/NAME`; an omitted CMake Git tag uses CMake's `master` default,
not an unrelated default branch. Missing/private repositories and deleted
branches remain unresolved rather than substituting another source.
With both `--introspect` and `--native-version-probes`, native scanning also
reads installed pkg-config metadata and bounded versions of explicitly
identified host tools. These are available environment alternatives, never
proof of original build selection. Provider paths, metadata hashes, versions,
constraints and host context are retained. Uninstalled `.pc` overrides are
disabled, source-local providers are rejected, and ambient credentials or
loader/startup injection variables are not passed to probes. No dependencies
are installed and no configure step is run. Missing or incompatible providers
remain unresolved.

For Atom header correlation, the host package file inventory is loaded only
when an include still needs attribution. RPM file lists come from the local
installed RPM database, not a repository query for a potentially different
release.
Formulation toolchain probes use successful stdout; failed probes and wrapper
diagnostics do not become version fields.

Concrete download metadata can be acquired separately without running an
installer or writing into the source tree:

```sh
bun contrib/native-download-cache.js --url https://example.org/release/installer.sh \
  --source-root /src/project --cache /external/native-source-cache
```

The explicit acquisition command follows HTTPS redirects, records a concrete
GitHub release asset where available, and reads supported constructor/CPack
installer headers. Release tags and installer package versions remain separate.
Downloads are streamed, bounded to 300 MiB and five minutes, and retained by
SHA-256 outside the source tree. Supported ISA XML archives are identified as
data artifacts rather than assigned a fabricated software version. Normal scans
read the frozen records through `CDXGEN_NATIVE_SOURCE_CACHE`; they do not refresh
`latest` or execute downloaded code.

A `.gitmodules` declaration alone is not a checked-out software component.
The inventory requires an observed Git status/gitlink or an existing in-root
source directory. A real uninitialized gitlink still supplies its immutable
revision. An absent declaration without either remains a
`cdx:cmake:submoduleDiagnostic`, retaining its path, URL, and declaration file;
it is not counted as a newly discovered software release.

Native release canonicalization uses evidenced package/repository identity, not
a global name-only join. Equivalent `v`-prefixed numeric tags and unprefixed
releases merge only when both the tag and release equivalence are evidenced.
Repeated source locations and revisions remain in
`cdx:native:canonicalOccurrence`; genuine releases remain distinct.
`cdx:native:canonicalRelease` identifies a release across separately retained
platform/artifact variants. Explicit patch or conflicting-content evidence is
not discarded. Dependency, parent, and requirement-candidate references follow
the canonical identities.

Cross-ecosystem Conan identity evidence can be acquired without executing a
recipe:

```sh
bun contrib/native-canonical-cache.js --cache /external/canonical-cache \
  --bom /external/previous-bom.json
CDXGEN_NATIVE_CANONICAL_CACHE=/external/canonical-cache \
  bun bin/cdxgen.js -t c /src/project --no-install-deps -o /external/bom.json
```

The producer snapshots conan-center-index at an immutable revision. The passive
generator verifies the cached config, recipe and versioned source metadata
hashes before joining a Conan release to upstream source identity. Use
`--revision` when acquiring again to reproduce the same recipe snapshot.
Unknown aliases remain separate rather than borrowing another package's identity.

For a mirrored archive whose upstream identity is not in its URL, an explicitly
downloaded artifact can supply its own project/header evidence:

```sh
bun contrib/native-archive-identity-cache.js --archive /external/source.archive \
  --url https://mirror.example.org/source.tar.gz --source-root /src/project \
  --cache /external/native-source-cache
```

The existing cache must be outside the source root. Acquisition reads bounded
archive metadata without extracting or executing source files. Passive scans
rehash the retained archive and metadata, require the component's exact version
and any declared SHA-256 to match, and preserve the original mirror URL/hash.
If two cached distribution URLs have authenticated evidence of the same
compressed bytes and independently named upstream project/release metadata,
the tool emits one component and retains both distribution references.
Different archive bytes or missing URL-bound evidence stay separate.
Unknown ownership remains separate; an archive filename alone cannot establish
an upstream package alias.

Normal C/C++ generation can acquire missing evidence directly from retained
source declarations with `--native-acquire --native-source-cache /external/cache`.
The cache must be outside every enclosing source checkout, including when
scanning a nested directory. Acquisition permission, cache placement and host
policy come only from operator launch arguments/environment, never project
configuration. `--native-acquire-hosts` accepts a comma-separated exact HTTPS
host allowlist, including redirect destinations. Offline and dry-run scans
retain named missing-evidence diagnostics instead of inventing versions.

Very large CycloneDX source inventories can opt into
`--native-evidence-format shared`. This stores each repeated exact
`cdx:build:requirement` JSON value once as a metadata property named
`cdx:build:requirementTable:sha256:<digest>`; `cdx:build:requirementTable=1`
identifies the format. Each `cdx:build:requirementLink` carries that entry's
`sha256:<digest>` value, not a component or dependency ref. Unique and
unsupported attachment shapes stay inline. A reader can validate and expand
either layout with `createNativeRequirementEvidenceIndex` in the native
requirement evidence module. Versions, dependency refs and exact occurrence
data do not change. `inline` is the default for readers that expect every
requirement property on its holder.
Shared mode reserves the table, entry, and link names; do not supply them as
custom metadata properties.

Provider contexts remain explicit where source declarations do not identify
them: `--native-registry-revision` pins a vcpkg commit;
`--native-rpm-repositories` supplies `fedora=HTTPS_BASE,updates=HTTPS_BASE`;
`--native-deb-repositories` supplies one or more comma-separated
`HTTPS_ROOT|SUITE|COMPONENT|ARCH|/absolute/TRUSTED_KEYRING.gpg` contexts;
quote each complete argument to protect the pipe characters. A trusted
operator keyring is required and the scanner does not consult host APT sources.
Successful bounded signed DEB acquisition writes an
`acquisitions/<key>.deb-replay.json` descriptor alongside its receipt.
If a later scan has a different query set, repeat `--native-deb-replay
/absolute/path/to/<key>.deb-replay.json` for up to four earlier descriptors.
Keep the corresponding `--native-deb-repositories` values in the launch:
a descriptor cannot grant signing trust. Replay rechecks the original
signed indexes or package archives and uses only matching queries from the
current scan. It reads external caches without fetching or updating them.
Executable ownership requires the literal name recorded in the signed
inventory. Two signed artifacts at the same package version remain separate
when their package SHA-256 differs; byte-identical sightings can be merged.
Project config and environment variables cannot select a replay descriptor.

For AMD's XRT PPA, if the signed archive has no Contents index, the scanner
can join the signed Packages index to the verified package's file inventory
for requested XRT and AIEBU tools. `--native-mlir-aie-wheel` takes an exact
`VERSION:WHEEL-TAG`, for example `1.4.4:cp312-cp312-manylinux_2_35_x86_64`.
When `aie-hsaco` is requested, the scanner checks that release's published
asset digest and reads its console-script metadata without installing it.
`--native-apple-sdks` supplies `owner/repository@COMMIT:SDK.sdk`;
`--native-cuda-release` and `--native-cuda-platforms` identify the published
redistributable release and artifact platforms. Minimum version constraints
never authorize a guessed latest release. The tool derives individual requests
from discovered requirements; no handwritten component inventory is required.

For a literal `find_program(... NAMES ... NO_DEFAULT_PATH)` search, a
distribution executable's recorded parent directory must match a search
directory or an explicit `PATH_SUFFIXES` directory. A private prefix that
only ends in the requested directory does not qualify. This check does not
infer unresolved search roots or select a build provider.

Acquisition records are emitted as `cdx:native:acquisition`. A downloaded owner
version remains separate from interface compatibility and build selection.
The C++ builder API is asynchronous: library consumers must
`await createCppBom(path, options)`. It retains parsed facts through acquisition
and rematerialization rather than rescanning the project.
Partial acquisitions retain their available evidence and named blockers during
offline reuse; explicit acquisition retries the incomplete context. All
producers share one bounded acquisition deadline. A newly authenticated source
is reconciled with the complete retained alternative set, including unchanged
cached sources: compatible alternatives can replace consumer placeholders,
while excluded alternatives retain their owner identity and restore unresolved
consumer requirements. Cold and warm generation preserve occurrence guards and
dependency references; acquisition never selects a build provider.

For a literal `ExternalProject_Add` whose options establish a separate,
default CMake configure, an authenticated source snapshot can supply a
`cmake-config-install-contract` for the original guarded declaration.
This records matching config-generation and install rules, not a generated
file, installed archive, or selected provider. Custom, disabled, or
ambiguous configure steps are not treated as standalone CMake.


Additional frozen provider inventories are read through
`CDXGEN_NATIVE_PROVIDER_METADATA`, using the operating system's path delimiter
for multiple manifest paths. Reading these hash-verified snapshots does not
require `--introspect` or `--native-version-probes`; both flags remain required
for installed-provider probes. Fixed-system archive decoding may still read
authenticated payload members. `contrib/native-provider-cache.js` acquires versioned WrapDB and
vcpkg recipe metadata. The CUDA, Android, Apple, Windows Git, and RPM
`contrib/native-*-provider-cache.js` commands acquire explicitly identified
package, SDK, or source metadata. Acquisition caches must be outside the scanned
source tree. Without `--native-acquire`, generation only reads these snapshots.
Neither mode installs a package or executes its build scripts. RPM snapshots retain exact package EVR
and owned file inventories. Apple framework versions come from explicit owning
linker metadata, not an SDK release or deployment target; literal linker
versions such as `0` remain distinguishable from an absent version.

Available providers are alternatives, not a claim about which dependency an
original build selected. Checked-out source and cached external providers are
evaluated independently for the same occurrence; a matching external provider
does not suppress a matching source version. Parent occurrence metadata and
dependency edges retain both. A package's owning release is distinct from the
version of an embedded pkg-config interface: numeric constraints use evidenced
interface versions, never an unrelated owner version.

`cdx:native:providerExports` records source-owned or authenticated provider
exports, while `cdx:native:packageIdentity` records a package alias established
by its own project and export metadata. Neither is inferred from a directory
name alone. Versioned artifact variants retain separate identities through
final BOM assembly, even when they share a package URL. Unversioned requests
still deduplicate normally while preserving all occurrence provenance.
An owner-shipped CMake config in `lib/cmake/<project>` can establish a
source-owned alternative without proving that it was configured, installed,
or selected. A literal `find_program(NAMES … PATHS … NO_DEFAULT_PATH)`
search excludes authenticated package paths proved to be outside those roots.

Cached exports are sourced only after their manifest, metadata and member/file
ownership evidence is authenticated. The native index verifies each cited
manifest once per collection and requires exact owner/version/export agreement;
a nonempty caller-supplied `source` or provenance marker is not authorization.
Installed-package observations use generation-local, object-bound evidence that
survives ordinary shallow component merges but is not serialized. JSON replay
must reobserve an installed provider; it cannot recreate that authorization.
Exact-selector source-cache exports use only the authenticated member inventory
and bytes: neighbouring unlisted config files, includes and install payloads do
not become exports.
Authenticated registry source members use the same literal Meson export parser
as source checkouts. Their declared installed libraries identify an available
source owner, not installed material: source and archive-inventory hashes remain
attached and search-root/ABI predicates stay unknown. Independently configured
embedded projects and unlisted adjacent files cannot inherit the parent release.
Conditional project owners likewise retain only branch-compatible exports.
Literal staged Meson renames are available candidates only when the invoked
script's parameter/copy flow, data-only read/replace/write helper bodies, exact
wrap archive SHA-256, owning recipe SHA-512, and archive member bytes agree.
The scanner does not execute the script or infer semantics from helper names.
Renamed exports retain original/source/transformed hashes and the invocation,
with staging, platform, header and installation predicates still unresolved.
The accepted script subset is lexed before interpretation: comments, quoted
strings and here-strings are data, function bodies require an actual supported
invocation, and identifiers are case-insensitive. Replacement arguments are
captured at their statements and only values reaching a verified writer affect
the projected export. Unsupported mutation or helper redefinition fails closed.
Discovery paths must genuinely interpolate the bound source parameter, not
contain a single-quoted literal dollar expression. Rereads after modeled writes
observe the written replacement history, so chained writes preserve final bytes.

An exported CMake interface version and its `SameMajorVersion`,
`SameMinorVersion`, `ExactVersion` or `AnyNewerVersion` policy are independent of
the source owner's release/revision. Unknown re-evaluation does not delete a
genuine export. A static target establishes its archive spelling, not a shared
object with the same basename. Scoped Find modules retain required-artifact
conjunctions; one known header/library is not proof that the complete Find
predicate passed. Bundled build-helper requirements refer to their source owner
and retain unresolved constituent checks instead of borrowing a tool's identity.

`find_program` records an executable requirement (`role: tool`), its destination
variable, and one ordered alternatives group; the destination is never software.
Python interpreter and development capabilities remain distinct, and compiler
feature checks identify their actual compiler owner without inventing a feature
release or claiming an unperformed compile/link check. Installed ConfigVersion
data retains an explicit interface version independently of its revision owner;
custom compatibility code remains unknown rather than acquiring a generic policy.

An observed installed CMake can authenticate bounded `Find*.cmake` contracts
using its fixed installation report and exact module hashes. Those contracts
reuse the scoped Find collector; CMake's own release is never the dependency
owner or interface version. Source-local modules take precedence, including
modules in an unversioned project. In-memory observation receipts survive normal
object spreads but are not serialized: a diagnostic JSON replay must reobserve
the installed tool rather than claim authentication from copied marker strings.

Literal CMake variable blocks discard local-only bindings; `PROPAGATE` retains
the named outward bindings. Executed `PARENT_SCOPE` writes capture values or
deletions at the statement, with macros preserving the enclosing lexical parent.
A bounded numeric-triple capture and the existing file/JSON readers can
derive root distribution inputs and pass them through real, condition-preserving
`add_subdirectory`/wrapper edges. Parent-prefix contexts and input hashes are
generation-local; blocks share existing command budgets. Installed data files
declared by `file(WRITE ...)` retain their real source owner, full generated
version/hash when derivable, and a distinct interface triple. Reachable custom
Find file-read/list/suffix contracts can link those owners without pretending an
installed file exists or that the rest of its version/search predicate passed.
Invoked finder helpers inherit caller bindings at their invocation; their local
assignments cannot rewrite the caller's filename list or retroactively change
an earlier search.
Generated installed files use the final modeled configuration bytes, not a
snapshot taken when an earlier `install(FILES ...)` statement was encountered.
Conditional overwrites retain both the changed payload and the unchanged
non-executing alternative with distinct guards.
Owner-discovery memo entries retain the variables, version evidence, context
observations and input provenance consumed by that pass. They do not retain
unconsumed fetch/requirement inventories or helper-definition tables for every
configured context. A private owner-query mode also avoids constructing those
unused inventories while preserving statement/helper execution, variable writes,
version evidence and context observations. Cacheable helper summaries still
collect complete inventories for their existing admission limits and accounting.
The public parser continues to return complete fetch/requirement observations;
all manifests, evaluations, contexts and analysis budgets remain unchanged.
Provider helper slices validate cached definitions by owner-local map identity
and mutation revision. Redefinition, deletion and clearing invalidate reuse;
inspection of unexecuted helper paths does not refresh the executed-slice cache.

The provider evaluator preserves quoted list arguments across helper calls and
interprets supported list removals, concrete `cmake_language(CALL ...)` targets
and `return()` boundaries. Unknown calls retain diagnostics rather than guessed
exports. Empty list loops do not execute; returned loop paths restore the outer
iterator binding. Conditional returns retain surviving-path guards, and
`return(PROPAGATE ...)` carries explicit values across scoped blocks.
An ordinary function's concrete parent-scope outputs remain usable inside its
caller's guarded branch; the caller's branch join handles uncertainty afterward.
Macro parent-scope writes retain their distinct escaping-scope semantics.
Macro formal arguments are literal substitutions, not caller variables; indirect
variable references still read the real variable scope. Nested helper definitions
retain their definition-site substitutions. Supported concrete
`cmake_parse_arguments` inputs discard empty elements, retain previous values
for repeated single-value keywords without values, and append repeated multi-value
arguments. Unresolved argument lists remain unknown: unknown text can change list
boundaries, so a later apparent keyword alone cannot establish a concrete field.
Decimal integer argument constants use zero/nonzero truthiness, separately from
variable-value false constants. Expanded condition lists retain quotation
provenance; `MATCHES` uses its literal expanded pattern operand. Supported
literal suffix matches and anchored literal replacements resolve flag helper
outputs without executing arbitrary source regular expressions. Repeated
start-anchor replacements whose result depends on unproved CMP0186 policy remain
unknown, as do unsupported expressions. These source candidates do not prove a
selected build.



Escaped quotes, parentheses, comment markers and spaces in unquoted CMake
arguments do not change command boundaries; in particular shell command
arguments cannot swallow a later real `find_package` declaration. Escaped
variable references remain literal, and bracket-comment usage examples are
still excluded. Literal status is local to each reference within an argument:
an escaped description or patch-command variable cannot suppress expansion
of an ordinary project version or fetched pin, including mixed literal and
ordinary references in one argument.

From the cache and surrounding files it recovers:

- **Resolved versions** for `find_package` entries, recorded with the property
  `cdx:cmake:resolvedVia=cmake-cache`.
- **FetchContent dependencies**, by reading the generated
  `<name>-populate-gitclone.cmake` script for the `GIT_REPOSITORY` and `GIT_TAG`.
  These become components tagged `cdx:cmake:depKind=fetch` and
  `cdx:cmake:resolvedVia=gitclone-script`.
- **Git submodules**, via `git submodule status --recursive` combined with
  each checkout's own `.gitmodules` and relative-URL scope. Components carry
  `cdx:cmake:depKind=submodule`, the full commit SHA and
  `cdx:version:kind=source-revision`; descriptive tags are retained separately
  as `cdx:cmake:gitDescribe`. Unpopulated checkouts are flagged with
  `cdx:cmake:uninitialised=true`.

Without a build tree, the dependencies a project downloads at configure time are
read from the CMake files themselves: `FetchContent_Declare`,
`ExternalProject_Add` and the CPM.cmake `CPMAddPackage` family (shorthand and
keyword forms). A git repository becomes a `pkg:github` purl (or `pkg:generic`
with a `vcs_url`) at its `GIT_TAG`; a GitHub archive URL becomes a `pkg:github`
purl at the ref it names; any other URL becomes a `pkg:generic` purl with a
`download_url` (user information and query strings removed), and `URL_HASH` a
hash. These components are tagged `cdx:cmake:depKind` = `fetch`,
`external-project` or `cpm` and `cdx:cmake:resolvedVia=cmake-lists`. When the
build tree resolves the same dependency, the gitclone entry replaces the
declared one, and a `find_package` of a fetched name does not add a second
component. CMake command names are matched in any case (`FIND_PACKAGE`,
`PROJECT`).

Mutable Git branches are retained as `cdx:cmake:gitRef`, not exact package
versions. Archive URLs can identify explicitly encoded releases or revisions;
revision identities are marked separately from releases and archive hashes are
preserved.

A source `project()` is kept independently of its `find_package` consumers,
including when `--project-name` and `--project-version` name a larger product.
`cdx:cmake:projectFile` and `cdx:cmake:subprojectDir` locate the declaration.
Source identities are path-qualified, so alternative build descriptions or
vendored releases with the same name are not silently merged.

Without running CMake, cdxgen reads literal `project(VERSION ...)`,
`rocm_setup_version(VERSION ...)`, explicit local version-file reads, bounded
local version modules, and supported numeric version-capture expressions.
Supported assignments, reads and includes are evaluated once in source order;
project declarations consume the bindings at their own position, not later
textual assignments. Local includes overwrite or invalidate earlier bindings
just as supported direct assignments do.
Unknown conditional or loop assignments and called local function/macro
mutations invalidate affected static bindings rather than choosing the last
textual value. Cleared variables and literal bracket arguments are not expanded
into stale or guessed releases. Version includes preserve their list-directory
context; this reader does not search or execute arbitrary CMake modules.
Adjacent `<component>_version` JSON metadata is read when a setup macro names
that component. Declared values carry `cdx:version:kind=declared-version`.
An actual tracked project manifest can instead identify its own Git source
revision; a containing repository's commit is never assigned to an unrelated
external dependency merely mentioned by `find_package`.

A package reference is reconciled only inside the actual source project's
own directory scope, preserving evidence and migrating graph references.
Uniqueness elsewhere in a checkout or recursive scan is not provider evidence.
Declared source versions must satisfy all supported EXACT, minimum and bounded
range requirements; unsupported constraints remain unresolved. A Git/archive
revision cannot prove satisfaction of a numeric release requirement. Conflicting
identities remain unresolved rather than selecting the first or newest candidate.
An umbrella archive's release is not the independent version of every package it exports.

For indexed manifests, provider discovery avoids evaluating function slices
whose complete recursive graph has no effect in this reader, including literal
non-target `set_property` operations; macros, direct parent-scope writes, possible
target modes and provider/file effects remain evaluated. Helper redefinition
invalidates slice reuse, and unindexed command-budget diagnostics are unchanged.

Different `find_package` minimums are retained under
`cdx:cmake:versionRequirements`; even their highest minimum is **not** an exact
resolved version. A build cache, matching source declaration or real source pin
is needed to supply one. Command-aware parsing does not treat search options,
unexpanded macro parameters or C/C++ strings as packages. `find_file` searches
are preserved as `cdx:cmake:fileSearch` metadata rather than fictitious packages.
Meson dependency literals use their owning project's `subprojects/*.wrap`
metadata, including for declarations in nested `meson.build` files.
Ancestor wrap lookup stops at the nearest independent Meson project or source
checkout boundary; nested projects do not inherit an enclosing project's wraps.

### Configuration-scoped provider capture

Capture is an explicit operation, separate from normal scanning. Run from the
local cdxgen checkout with already installed CMake/Meson and Linux bubblewrap:

```sh
bun bin/native-dependency-capture.js --tool cmake \
  --source /absolute/source --build /absolute/empty-external-build \
  --output /absolute/external/facts.json -- -DCMAKE_BUILD_TYPE=Release
bun bin/cdxgen.js -t cpp --no-install-deps \
  --native-dependency-facts /absolute/external/facts.json \
  --cmake-cache /absolute/empty-external-build/CMakeCache.txt \
  -o /absolute/external/bom.json /absolute/source
```

For Meson, use `--tool meson` and put setup arguments after `--`. Capture
performs configure-only evaluation with read-only sources, external outputs
and isolated networking. It does not install tools or fetch missing providers.
Existing nonempty build directories and source-internal output paths are
refused. Configure still runs project code; this is not a general-purpose
zero-trust build sandbox.

CMake compares observed package-config selection against an uninstrumented
configure, preserves existing top-level initializers and fingerprints actual
version inputs. Meson requires real configured dependency/fallback evidence.
The normal scanner only reads the facts; it never launches capture or an
implicit configure. Missing staged dependencies are prerequisites, not an
invitation to substitute a host package.

Facts are bound to the exact source root, executed callsite, complete
constraints, cache/configuration and provider inputs. Changed or foreign
inputs invalidate them. Unsupported discovery stays unknown. The manifest is
unsigned evidence, not machine attestation: protect its build/evidence files.
Capture one GPU/toolchain/sysroot profile at a time; child ExternalProject
configures need their own evidence and are not resolved by root scheduling.

Distinct configured providers can share the same valid upstream PURL while
having distinct `#native-provider-...` BOM references. Ordinary PURL
deduplication remains unchanged, and dependency endpoints follow each selected
provider. Source inventories with configured annotations are not proof that
every conditional source requirement belongs to one complete built release.



### Presets, compilers and hardening

`CMakePresets.json` and `CMakeUserPresets.json` (schema versions 1 to 10) are
read with their `include` files. Presets are resolved as CMake does: `inherits`
chains (the first parent wins), hidden templates, `cacheVariables` and
`environment` merged key by key, and the macros `${sourceDir}`,
`${sourceParentDir}`, `${sourceDirName}`, `${presetName}`, `${generator}`,
`${hostSystemName}`, `${fileDir}`, `${dollar}`, `${pathListSep}`, `$env{}` and
`$penv{}`. `condition` objects are evaluated for the host cdxgen runs on;
`matches` conditions are not, since their regular expressions come from the
repository. Each visible configure preset becomes a formulation component
(`type: data`) with its generator, build directory, build type, compilers,
toolchain file (a vcpkg toolchain is flagged with `cdx:cmake:preset:vcpkg`)
and the hardening options its flag variables set. Its build directory is where
cdxgen then looks for `CMakeCache.txt` and `compile_commands.json`.

The compilers of the build become formulation components (`type: platform`).
cdxgen reads CMake's own description of each compiler in the configured build
tree (`CMakeFiles/<version>/CMake<LANG>Compiler.cmake`: the compiler's path,
CMake's id and its version), and for a compiler the compilation database names
that CMake did not describe it runs `<compiler> --version` and classifies the
answer: gcc, clang, apple-clang, msvc, clang-cl, nvcc, icx, icc, nvhpc, or a
compiler built on the EDG front end (its banner mentions the Edison Design
Group; such a component carries `cdx:cpp:frontend=edg`). Only a driver named
like one of these compilers is run, and only when it is found on the `PATH` or
named by an absolute path outside the project: a compilation database can come
with the code it describes, so a compiler inside the project is never run. In
secure mode no compiler is run, and only an explicit `--compile-commands` is
read.

The project component carries the security-hardening options the build uses:
`cdx:cpp:hardening:fortifySource`, `stackProtector`, `pie`, `relro`,
`cfProtection`, `sanitizers`, `glibcxxAssertions`, `stackClashProtection`,
`msvcBufferSecurityCheck` and `msvcControlFlowGuard`. From a compilation
database each setting takes its most common value, with the number of units
using it in `cdx:cpp:hardening:<setting>:units` (out of
`cdx:cpp:compileCommands:units`); link-time settings such as RELRO come from
the configured build tree's linker flags, which a compilation database does not
show. `cdx:cmake:buildType` names the configuration the evidence describes.

```bash
jq '.metadata.component.properties[] | select(.name | startswith("cdx:cpp:hardening"))' bom.json
jq '.formulation[].components[] | select(.type == "platform" or .type == "data") | {type, name, version}' bom.json
```

Inspect the CMake-resolved dependencies:

```bash
jq '.components[] | select(.purl | startswith("pkg:github")) | {name, version,
  depKind: (.properties[] | select(.name=="cdx:cmake:depKind") | .value)}' bom.json
```

## 6) Vendored libraries and build-vs-runtime scope

C/C++ projects routinely vendor third-party code as headers or static archives.
cdxgen addresses this in two ways:

1. **CMake context boundaries.** FetchContent and submodule entries are
   distinguished from plain `find_package` requirements by the `cdx:cmake:depKind`
   property. A submodule pinned to a commit SHA is a real, checked-out thing; a
   `find_package` line is a version requirement the build may or may not satisfy.
2. **Code carried under its own license.** A directory with its own license
   file (`LICENSE`, `LICENCE`, `COPYING`, with or without an extension or a
   suffix such as `LICENSE-MIT`) whose license differs from the project's is a
   vendored component: `pkg:generic/<directory>#<path>`, the license it states
   (in `licenses` and `evidence.licenses`), `cdx:vendored=true`,
   `cdx:vendored:path` and `cdx:vendored:licenseFile`. The license is read from
   the text's own title first, since a license text quotes others (the GNU GPL
   names the GNU Lesser GPL). Directories CMake already knows as fetched or
   submodule sources, and build trees, are not searched, and a directory inside
   a vendored one is part of it. Headers under a vendored directory are not
   the project's own headers. The version comes from the library's own version
   header when it is one cdxgen knows (brotli's `c/common/version.h`, `zlib.h`,
   zstd's `lib/zstd.h`, lz4's `lib/lz4.h`, `png.h`, `sqlite3.h`, expat's
   `lib/expat.h`), which also gives the component the CPE NVD names it by, or
   else from the directory's own CMake version declarations or tracked project
   source revision; `cdx:vendored:versionSource` names the evidence file.
   Python `*.dist-info/licenses` directories use the owning `METADATA` Name and
   Version, not the directory name or the license snippet. Vendored Python
   libraries and copied wheel licenses use an exact matching `vendor.txt` pin
   when available and share the corresponding PyPI identity. A wrapper
   distribution's version is never substituted for a bundled native library's
   version.
   A vendored brotli tree also
   carries `cdx:brotli:c:blockSwitchFix`, read from its `decode.h`, which the
   `BROTLI-RCE-002` audit rule checks for CVE-2026-111497. Bazel workspaces
   under `third_party/`, `vendor/` or `external/` belong to the copied
   project: they are neither built nor read for `bazel_dep` entries.
3. **Include analysis with atom.** When C/C++ is requested explicitly with `-t`,
   or `--deep` is passed (and the project is not a container/OS scan),
   `getCppModules` invokes the `atom` companion helper to produce C usage
   slices: in header mode (`atom -l h`, no function bodies) by default, and as a
   full parse (`atom -l c`) with `--deep`. Every `#include` is resolved to a file, mapped to an
   OS package when possible, and otherwise emitted as a `generic` component with
   a `Filename` identity method. Imported symbols are recorded under
   `internal:ImportedSymbols`. A header that is the project's own is not a component: one found under the
   project root, its `include/` or `src/` directory, or an include directory of
   the project's compilation database, outside the source directories of its
   fetched, submodule and vendored dependencies. A C standard library or POSIX
   header (`stdio.h`, `sys/mman.h`, `unistd.h`, ...) is a component only when an
   OS package provides it. Unless a usages slice is reused, neither atom nor
   the osquery lookup of installed development packages runs when the tree has
   no C or C++ source, header or module file outside `node_modules` and dot
   directories.

   With atom 4 and later each include's usages slice names the file it
   resolved to (`resolvedPath`) and the functions the including file calls
   that the header declares (`importedSymbols`, with function bodies parsed).
   The resolved file then attributes the header exactly: to the project
   itself, to a fetched, submodule or vendored dependency whose directory
   holds it, to the vcpkg port that installed it
   (`vcpkg_installed/vcpkg/info/*.list`; a declared port then gets the
   installed version and `cdx:vcpkg:triplet`), to the Conan package in the
   cache (Conan 1 paths, or the Conan 2 cache database under `CONAN_HOME`), or
   to the OS package that owns the file (`dpkg-query -S`, `rpm -qf`,
   `apk info -W`, or the Homebrew Cellar). The imported symbols become the
   component's `internal:ImportedSymbols`, and `evinse -l c` uses them to
   attach occurrence evidence for the calls. With an older atom, headers are
   attributed by name as before.

When the project has a JSON compilation database, atom parses each file with
the include paths, macros and language its build uses instead of guessing them.
cdxgen looks for `compile_commands.json` in the scan root, then in the same
build directories as `CMakeCache.txt` (next to the `--cmake-cache` file, the
presets' build directories, then the conventional ones), and passes the first
it finds to atom (`--frontend-args compile-commands=<path>`)
when the installed atom lists that key in `atom --frontend-args-keys -l c`
(atom 4.0 and later). An older atom is run with its usual arguments.
`--compile-commands <file|dir>` names a database
explicitly, for an out-of-tree build. CMake writes the database with
`-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, Meson always does, and `bear -- make`
records one for other builds. atom asks the GCC or Clang driver a command names
for its predefined macros, but only a driver found on the `PATH` or given by an
absolute path outside the project; since a database can come with the code it
describes, secure mode (`CDXGEN_SECURE_MODE=true`) uses only an explicit
`--compile-commands`. The same database is used by `evinse -l c`.

This step uses the atom companion — a native binary on most platforms, needing
Java 23+ only on the jar-based darwin-amd64, windows-arm64, and linux-arm64-musl
triples — which is why a scan that detects C/C++ among other project types runs
it only with `--deep`, and container and OS scans skip it entirely.

## 7) CI sketch

C/C++ benefits from building first, so the CMake cache and FetchContent scripts
exist for cdxgen to read:

```yaml
jobs:
  sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - name: Configure build
        run: cmake -S . -B build
      - name: Generate SBOM
        run: cdxgen -t c++ -o bom.json --deep .
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: bom.json
```

Checking out submodules recursively avoids the uninitialised-pinned-to-SHA case,
and a configured build tree lets cdxgen resolve real versions instead of
emitting requirements.

## What to take away

1. `cdxgen -t c++` scans for Conan, vcpkg, meson, CMake, and collider inputs in
   one pass, in that priority order.
2. Lock files (`conan.lock`, `collider.lock`) give resolved versions and a graph;
   manifest files (`conanfile.txt`, `vcpkg.json`, `CMakeLists.txt`,
   `meson.build`) give declared dependencies and requirements.
3. vcpkg support reads `vcpkg.json` only, not the installed tree; a preset
   using vcpkg's toolchain is flagged in formulation.
4. CMake cache resolution turns `find_package` requirements into resolved
   components and separately captures FetchContent and submodule pins.
5. Include analysis via atom (header mode for an explicit `-t c`, a full parse
   with `--deep`) is how vendored headers and static libraries get represented;
   the project's own headers are left out.
6. CMake presets and the compilation database describe the build itself:
   configure presets and compilers in formulation, hardening options on the
   project component.
