# Installing the Donkey Car Simulator

The app is distributed as an unsigned Linux AppImage and unsigned macOS DMGs
(Apple Silicon and Intel). Signing and notarization are out of scope for this
release.

## Linux (x86_64)

1. Download the `Donkey-Car-Simulator-*.AppImage`.
2. Make it executable: `chmod +x Donkey-Car-Simulator-*.AppImage`.
3. Launch it. On some desktops you may need FUSE 2 (`libfuse2`) for AppImage
   mounting; if launching fails, extract with `--appimage-extract` and run the
   unpacked binary.

The app needs a host C++ compiler. Install one before building firmware:

- Debian/Ubuntu: `sudo apt-get install build-essential clang`
- Fedora: `sudo dnf install gcc-c++ clang`
- Arch: `sudo pacman -S base-devel clang`

Set `CXX` to override the compiler (for example `CXX=clang++`).

## macOS (Apple Silicon and Intel)

1. Open the matching `.dmg` and drag the app into `/Applications`.
2. First launch is blocked by Gatekeeper because the app is unsigned. Right-click
   the app and choose **Open**, then confirm. Alternatively run
   `xattr -dr com.apple.quarantine /Applications/Donkey\ Car\ Simulator.app`.

Install the Xcode Command Line Tools for the C++ compiler:

```
xcode-select --install
```

## Runtime notes

- Packaged apps run the HAL build driver through the bundled Electron runtime;
  no separate Node installation is required.
- Build caches are stored in the app's user data directory and are writable.
- The firmware template and HAL sources are installed under the app resources.