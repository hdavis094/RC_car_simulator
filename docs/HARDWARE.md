# Build, flash, and monitor an ESP32

Open a car project and switch to **Terminal**. **Build for ESP32** saves the project edits and runs `pio run -e esp32dev` in the project folder. The Build output tab shows PlatformIO output and clickable compiler diagnostics. **Cancel build** stops the active build or upload.

If the app cannot find PlatformIO Core, choose **Install PlatformIO** or accept the install prompt when you build or flash. The app looks for `pio` or `platformio` on `PATH`, in common user install locations, and in its own Python environment. Installation requires Python 3 with `venv` and `pip` and network access to PyPI. On Debian and Ubuntu, install `python3-venv` if Python cannot create the environment. On macOS, use a working Python 3 installation with its TLS certificates configured. The app installs Core under its user data directory without administrator privileges. The first ESP32 build also downloads the project's board toolchain and libraries. See the [PlatformIO Python prerequisites](https://docs.platformio.org/en/stable/faq/install-python.html) and [Core installation guide](https://docs.platformio.org/en/stable/core/installation/methods/installer-script.html).

1. Connect the ESP32 with a USB data cable. In **Serial Monitor**, select **USB**, then select the device under **Port**. Use **Refresh ports** after plugging it in if the list is already open.
2. Select **Flash to ESP32**. The app closes its USB serial connection before running `pio run -e esp32dev -t upload --upload-port <port>`. Close any other serial monitor using that device, including a shell session running `pio device monitor`.
3. When the upload finishes, return to **Serial Monitor**, enter the firmware's baud rate, and select **Connect**. The starter firmware uses `115200` baud. **Send** writes the line as UTF-8 with a trailing LF. **Simulator** switches back to the simulated UART and closes any USB connection.

## Linux device permissions

Look for `/dev/ttyUSB*` or `/dev/ttyACM*`. If a device is missing, try a known USB data cable and check whether the system detects the board. If a device is listed but opening it fails with a permission error, run `ls -l /dev/ttyUSB0` (substitute your device) to identify its owning group and `id` to check your memberships. For supported devices, follow PlatformIO's udev rule instructions and reconnect the board after reloading the rules. Alternatively, have an administrator add your account to the group shown by `ls -l`, such as `dialout` or `uucp`, then sign out and back in before relaunching the app. See [PlatformIO's Linux udev and group setup](https://docs.platformio.org/en/stable/core/installation/udev-rules.html).

## macOS USB serial drivers

Look for a new `/dev/cu.*` device after connecting the board. On an Apple Silicon laptop, unlock the Mac and approve the accessory if prompted. Check **System Information → USB** if the device does not appear. If the Mac sees the USB bridge but there is no serial device, identify the bridge from your board documentation or its USB vendor and product IDs. See [Apple's USB accessory guidance](https://support.apple.com/en-us/102282).

- **CP210x**. Use the Silicon Labs macOS Virtual COM Port driver and follow its installation and compatibility notes for your macOS version when the board needs a driver. See [Silicon Labs CP210x downloads](https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers).
- **CH340 or CH341**. If macOS already exposes a working port, use that port. If the bridge needs a driver, use WCH's macOS package for your chip and OS and follow its included install guide. See [WCH CH341SER_MAC](https://www.wch-ic.com/downloads/CH341SER_MAC_ZIP.html).
