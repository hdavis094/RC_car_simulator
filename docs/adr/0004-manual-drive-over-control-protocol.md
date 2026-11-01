# Manual driving goes through the firmware's control protocol

Keyboard and gamepad input is sent to the firmware as control-protocol `drive` commands over the car's simulated Wi-Fi. It never goes straight into the physics. Injecting it directly would be simpler and would work without firmware, but on the real car manual commands arrive over the network, and the point of the sim is to exercise that path: parsing, mode switching, the 500 ms failsafe, latency and dropouts. The app's control client works unchanged against the real car's IP.
