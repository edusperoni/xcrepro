# xcrepro

Reproducible, path-independent `.xcframework` builds. Build on your laptop, build in CI: same bytes, and no trace of who built it or where.

```sh
npx xcrepro build --project ios/MyLib.xcodeproj --scheme MyLib --platforms ios,ios-sim,catalyst -o dist
```

## Why

A plain `xcodebuild` framework build embeds the machine it ran on:

- Absolute source paths, from `__FILE__`, Swift `#file` and DWARF.
- `~/Library/Developer/Xcode/DerivedData/<Project>-<random>/...` paths, including your username.
- The Xcode install path (`/Applications/Xcode_26.1.app/...`), which differs between machines and CI images.
- Absolute `-I`/header-map paths serialized into `.swiftmodule` files and copied into the dSYM.
- A linker debug map (`N_OSO`/`N_AST` stabs) of absolute object-file paths, which also feeds the binary's `LC_UUID`.
- dSYM relocation maps with the absolute binary path.
- An `Info.plist` whose `AvailableLibraries` order changes from build to build.

So every rebuild produces a diff, the output exposes your filesystem, and you can't check a published binary against its source. If you ship a Swift Package `binaryTarget`, it also means a new checksum on every rebuild.

`xcrepro` fixes all of the above. `xcrepro verify` proves it by building twice from different absolute paths and comparing hashes.

## Install

```sh
npm i -D xcrepro           # or run it ad hoc: npx xcrepro ...
```

Without Node, download a standalone binary (`xcrepro-darwin-arm64` / `xcrepro-darwin-x64`) from the [releases](https://github.com/edusperoni/xcrepro/releases) and check it against `SHA256SUMS`.

Previews of every PR and commit on `main` are published by [pkg.pr.new](https://pkg.pr.new). The bot comment on each PR has the URL, e.g. `npx https://pkg.pr.new/xcrepro@<pr-or-sha>`. Each CI run also uploads the `npm pack` tarball and the binaries as workflow artifacts.

## Usage

```
xcrepro build     [options]           Build an .xcframework reproducibly
xcrepro verify    [options]           Build twice from different paths and compare
xcrepro normalize <xcframework>       Post-process an existing .xcframework in place
xcrepro scan      <path> [--root dir] Report machine-specific paths in build output
xcrepro hash      <path>              Print the content hash of a file or directory
xcrepro xcconfig                      Print the build settings as an .xcconfig
```

Options can live in `xcrepro.config.json` (paths are relative to the file):

```json
{
  "project": "native-src/ios/MyLib.xcodeproj",
  "scheme": "MyLib",
  "platforms": ["ios", "ios-sim", "catalyst", "xros", "xros-sim"],
  "output": "platforms/ios"
}
```

Platforms: `ios`, `ios-sim`, `catalyst`, `macos`, `tvos`, `tvos-sim`, `watchos`, `watchos-sim`, `xros`, `xros-sim`.

`build` prints the xcframework path and its content hash. It exits non-zero if the leak scan finds a machine-specific path (see `--allow`). `--manifest out.json` records the hash and Xcode version.

### Source root

Paths under the **source root** are recorded relative to it. It defaults to the git top-level of the project, so sources anywhere in the repo are covered. Intermediates go to `<project dir>/build/xcrepro`, which must be inside the root.

### Bring your own build script

If you drive `xcodebuild` yourself:

1. Pass `-xcconfig node_modules/xcrepro/xcconfig/reproducible.xcconfig XCREPRO_ROOT=<root>` and `-derivedDataPath <inside root>`, with `ZERO_AR_DATE=1` in the environment.
2. Run `xcrepro normalize <xcframework>` after `-create-xcframework`.
3. Run `xcrepro scan <xcframework> --root <root>` to check the result.

## What it does

| Problem | Fix |
|---|---|
| Source paths in debug info, `__FILE__` | `-ffile-prefix-map` (clang) and `-file-prefix-map` (swiftc) for every spelling of the root (`/private/tmp` vs `/tmp`, symlinks) |
| Xcode install path in debug info | Remap the active `DEVELOPER_DIR` to `/Applications/Xcode.app/Contents/Developer` |
| DerivedData in your home directory | `-derivedDataPath` inside the source root, so it's remapped too |
| Swift `#file` is an absolute path | `SWIFT_UPCOMING_FEATURE_CONCISE_MAGIC_FILE`: `#file` becomes `Module/File.swift` (`--no-concise-magic-file` to opt out) |
| Search paths serialized in `.swiftmodule` and dSYM | `SWIFT_SERIALIZE_DEBUGGING_OPTIONS=NO` |
| DWARF references to clang module caches (`.pcm`) | `-no-clang-module-breadcrumbs` (Swift), `CLANG_ENABLE_MODULE_DEBUGGING=NO` (clang) |
| Linker debug map with absolute paths | Strip debug symbols after the dSYM is made (`STRIP_STYLE=debugging`, as `xcodebuild archive` does) |
| `LC_UUID` hashed from that debug map | Re-derive each slice's UUID from its stripped bytes and apply it to the matching dSYM slice |
| `.swiftsourceinfo` with absolute paths | Remove `*.swiftmodule/Project/`, which the compiler sets apart for exactly this |
| Absolute path in dSYM `Relocations/*.yml` | Rewrite it to the binary's path inside the xcframework |
| `Info.plist` library order | Sort, then serialize with `plutil` to keep Apple's exact formatting |
| Static archive timestamps | `ZERO_AR_DATE=1` |

## Limitations

- **Same Xcode, same output.** Different Xcode versions produce different code. CI and local builds match only on the same Xcode build; `--manifest` records the version.
- **Swift `#filePath` can't be remapped**: no compiler flag covers it. The scan reports it. Use `#fileID` or `#file`.
- **Frameworks only for now.** Static-library xcframeworks aren't built yet; `normalize` and `scan` work on any xcframework.
- **Signing**: builds are unsigned (`CODE_SIGNING_ALLOWED=NO`). Sign after `xcrepro` runs: signing first and normalizing after would invalidate the signature.
- **Zipping for SPM**: `zip` stores timestamps. A deterministic zip mode is planned.

## Development

```sh
npm ci
npm test                 # unit tests (macOS: uses plutil)
npm run build            # dist/
node src/cli.ts verify --project fixtures/Sample/Sample.xcodeproj --scheme Sample --platforms ios
npm run compile          # standalone binaries via Bun, into dist-bin/
```

`src/version.ts` and `xcconfig/reproducible.xcconfig` are generated (`npm run gen`); CI fails if they're stale.

### Releasing

`npm version <patch|minor|major|prerelease>` regenerates the derived files and tags. Then push with `git push --follow-tags`. The `Release` workflow publishes to npm via trusted publishing (OIDC, with provenance) and attaches the binaries to a GitHub release. Prerelease versions (`1.2.0-beta.0`) go to the `next` dist-tag.

## License

MIT
