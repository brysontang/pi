# Native clipboard prebuilds

The platform directories contain checked-in N-API binaries used by the package loader. Rebuild them with `packages/clipboard/scripts/build-native.mjs`; see the package README for commands and toolchain requirements.

After rebuilding, run the package test on each native target before updating the checked-in prebuild.
