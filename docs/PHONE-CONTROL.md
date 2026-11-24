# Drive from a phone

1. Connect the desktop and phone to the same trusted local network.
2. Start a simulation. For a real car, expand **Phone control** in the **Network Console**, enter the car's LAN address and TCP port, and choose **Connect to real car**. The starter firmware uses TCP port 3333 unless the car project changes it.
3. Wait for the Network Console to show a connected link. Choose **Enable phone control**, then open the copied LAN link in the phone's browser. Choose the address the phone can reach if the desktop displays several.
4. Select **Manual mode** in the phone browser. Hold the direction buttons to drive and release them to stop. **Emergency stop** sends the car's e-stop command.
5. Choose **Disable phone control** on the desktop to close the session.

Links expire after 15 minutes. Each link authorizes one connected browser at a time. Opening a different browser requires closing the first one. Moving to another tab or releasing the phone buttons ends held drive. The desktop also releases drive when drive updates stop arriving.

The desktop serves the controller over HTTP and WebSocket on the local network. Keep the invitation private, use a trusted LAN and leave the port closed to the Internet. The desktop relays control messages over its existing TCP connection to the car.

[Control-protocol message reference](../packages/control-protocol/SPEC.md) · [WebSocket server reference](https://github.com/websockets/ws/blob/master/doc/ws.md)
