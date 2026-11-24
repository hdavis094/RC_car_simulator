# Installing the Donkey Car Simulator

The app is distributed as an unsigned Linux AppImage and unsigned macOS DMGs
(Apple Silicon and Intel). Signing and notarization are out of scope for this
release.

## Linux (x86_64)

1. Download the `Donkey-Car-Simulator-*.AppImage`.
2. Make it executable: `chmod +x Donkey-Car-Simulator-*.AppImage`.
3. Launch it. On systems where AppImage mounting is unavailable, run it with `--appimage-extract-and-run`.

The app needs a host C++ compiler. Install one before building firmware:

- Debian/Ubuntu: `sudo apt-get install build-essential clang`
- Fedora: `sudo dnf install gcc-c++ clang`
- Arch: `sudo pacman -S base-devel clang`

Set `CXX` to override the compiler (for example `CXX=clang++`).

## macOS (Apple Silicon and Intel)

1. Open the matching `.dmg` and drag the app into `/Applications`.
2. Try opening the app. If Gatekeeper blocks it and you trust the build, open **System Settings > Privacy & Security**, choose **Open Anyway**, and confirm. [Apple first-launch instructions](https://support.apple.com/en-us/102445)

Install the Xcode Command Line Tools for the C++ compiler:

```
xcode-select --install
```

## Runtime notes

- Packaged apps run the HAL build driver through the bundled Electron runtime;
  no separate Node installation is required.
- Build caches are stored in the app's user data directory and are writable.
- The firmware template and HAL sources are installed under the app resources.
