# @earendil-works/clipboard

Native clipboard access for Node.js and Bun. The package supports text, images, HTML, rich text, and clipboard format inspection on macOS, Windows, and Linux.

This code originated in [`@crosscopy/clipboard`](https://github.com/CrossCopy/clipboard) and was maintained as [`@mariozechner/clipboard`](https://github.com/earendil-works/clipboard) before moving into the pi monorepo. It wraps platform clipboard APIs with Rust and [napi-rs](https://napi.rs/).

## Usage

```js
import Clipboard from "@earendil-works/clipboard";

console.log(await Clipboard.getText());

if (Clipboard.hasImage()) {
	console.log(await Clipboard.getImageBinary());
}
```

See [`index.d.ts`](./index.d.ts) for the complete API.

## Native prebuilds

Prebuilt N-API libraries are stored under `native/<platform>/prebuilds`, like the native helpers in `@earendil-works/pi-tui`. They are part of the source tree and the npm package, so normal installs and releases do not run Rust build scripts or depend on separately published platform packages.

Build the current Rust host target:

```sh
npm --prefix packages/clipboard run build:native
```

Build both macOS or Windows targets on the corresponding host:

```sh
npm --prefix packages/clipboard run build:native:darwin
npm --prefix packages/clipboard run build:native:win32
```

Build one explicit target with:

```sh
npm --prefix packages/clipboard run build:native -- --target x86_64-unknown-linux-gnu
```

The build runs `cargo build --locked --release` and copies the resulting library to its checked-in prebuild location. Cross-target builds require the Rust target, linker, SDK, and system libraries for that target. macOS prebuilds use the same deployment targets as pi-tui: macOS 11 for arm64 and macOS 10.15 for x64.
