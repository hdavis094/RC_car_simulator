# Donkey Car Simulator v1 demo

## Setup

- Linux x86_64 needs Node 26, the pnpm version in the repository's `package.json`, GCC or Clang with C++17 support, and a graphical session that can run Electron. Install a desktop build toolchain, including make and Python, if pnpm needs to build the terminal's native addon.
- macOS 14 or newer needs Node 26, the pinned pnpm version, and Apple's C++ toolchain. Install the Xcode Command Line Tools with `xcode-select --install` if `xcode-select -p` fails.
- From the repository root on either platform, run `pnpm install --frozen-lockfile` and then `pnpm dev`. This demo builds firmware for the simulator using the local C++ toolchain.

## Walk through the app

1. Choose **New project**, enter an absolute path for an empty folder, and click **Create project**. The starter firmware opens in the **Terminal**.
2. Open **Workbench**. Confirm the project has an ESP32, steering servo, ESC and motor, and distance sensors. Inspect the pin assignments and verify the wiring report shows **0 errors**.
3. In **Terminal**, open `src/main.cpp` and inspect the starter sketch. Click **Build for Sim**. Wait for **Build: succeeded** and inspect the build output.
4. In **3D World**, choose **Oval**, **1×** speed and seed **1**. Select **Cone** and place two cones at approximately `(2.2, -1.5)` and `(-2.6, 1.5)` metres in the X/Z plane. The placement coordinates and ground click let you use the fixed v1 layout. Save the layout if you want to reuse it.
5. Click **Run** and wait for **Starting…** to change to **Pause**. In **Serial Monitor**, look for `Donkey Car starter firmware`. In **Network Console**, wait for **connected** and a telemetry line. The footer shows the mapped **Control port**.
6. Let **Sim time** pass 3 s so the ESC is armed. Click **Auto**. Watch the car negotiate both cones, the lap counter increment and the collision counter stay at zero. You can also send `{"t":"mode","mode":"auto"}` from the Network Console.
7. Click **Manual**. Focus the 3D World and use W/S to drive and A/D to steer. Connect a supported gamepad via USB or Bluetooth and press a button while the app is focused. The left stick steers and can also drive forward or reverse. On standard gamepads, the right and left triggers control forward and reverse. Verify the drive readout and car both respond. Release inputs to neutral, and use Space or **E-STOP** to stop the car.

## Connect an external client

1. With the simulation still running, write down the **Control port** from the footer. Click **Disconnect** in the Network Console to release the firmware's controller connection.
2. In a system terminal, run `nc 127.0.0.1 <port>`, substituting the mapped host port. Expect a `hello` message followed by telemetry. Enter the following JSON on a line and confirm that telemetry reports `manual`.

   ```json
   {"t":"mode","mode":"manual"}
   ```

3. Quit `nc`, reconnect the Network Console if desired, and click **Stop** in 3D World. The footer should show **Run: ended**.

## Headless acceptance

Run `pnpm test:scenarios` to build the starter firmware and check the 60-second seed-1 run. Run `node scenarios/run.ts --seeds 1-10` to report all ten seeds. Run `pnpm verify` for the full suite, including the Playwright desktop demo.


## Desktop settings

Open **Settings** to choose the dock position, initial simulation speed, or physics model. These preferences persist across restarts. Use Cmd or Ctrl with 1, 2, or 3 to switch environments, and Cmd or Ctrl with comma to open Settings. Pick physics **Stage 1** and speed **1×** for the v1 walkthrough above.

## Phase 3 features

- [Build, flash, and monitor an ESP32](HARDWARE.md) from Terminal and the USB Serial Monitor.
- [Drive from a phone](PHONE-CONTROL.md) using a session link from Network Console.
- [Install the AppImage or DMG](INSTALL.md) and set up the host compiler.
