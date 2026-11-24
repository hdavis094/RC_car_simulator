/* global document, location, window */
const connection = document.querySelector('#connection');
const telemetry = document.querySelector('#telemetry');
const buttons = document.querySelectorAll('button');
const inputs = new Map();
const commands = {
  forward: [1, 0],
  reverse: [-1, 0],
  left: [0, -1],
  right: [0, 1],
};
const keys = { ArrowUp: 'forward', ArrowDown: 'reverse', ArrowLeft: 'left', ArrowRight: 'right' };
const token = location.hash.slice(1);
let socket;
let sequence = 0;

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function drive() {
  let throttle = 0;
  let steer = 0;
  for (const name of inputs.values()) {
    const [nextThrottle, nextSteer] = commands[name];
    throttle += nextThrottle;
    steer += nextSteer;
  }
  send({
    t: 'drive',
    seq: sequence++ >>> 0,
    throttle: Math.sign(throttle),
    steer: Math.sign(steer),
  });
}

function release() {
  if (inputs.size === 0) return;
  inputs.clear();
  drive();
}

for (const button of document.querySelectorAll('[data-drive]')) {
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    inputs.set(event.pointerId, button.dataset.drive);
    drive();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, (event) => {
      if (inputs.delete(event.pointerId)) drive();
    });
  }
}

window.addEventListener('keydown', (event) => {
  const name = keys[event.key];
  if (!name || socket?.readyState !== WebSocket.OPEN) return;
  event.preventDefault();
  if (event.repeat) return;
  inputs.set(event.key, name);
  drive();
});
window.addEventListener('keyup', (event) => {
  if (inputs.delete(event.key)) drive();
});
window.addEventListener('blur', release);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) release();
});
window.addEventListener('pagehide', () => {
  release();
  socket?.close();
});
document.querySelector('#manual').addEventListener('click', () => {
  release();
  send({ t: 'mode', mode: 'manual' });
});
document.querySelector('#estop').addEventListener('click', () => {
  release();
  send({ t: 'estop' });
});
setInterval(() => {
  if (inputs.size > 0) drive();
}, 100);

if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
  connection.textContent = 'Open the phone control link from the desktop Network Console.';
} else {
  socket = new WebSocket(`ws://${location.host}/control`, ['rcsim.control.v1', token]);
  socket.addEventListener('open', () => {
    connection.textContent = 'Controller connected';
    for (const button of buttons) button.disabled = false;
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.t === 'telemetry') {
      const mode = message.estop ? 'Emergency stop' : message.mode;
      telemetry.textContent = `${mode} · Throttle ${message.throttle.toFixed(2)} · Steering ${message.steer.toFixed(2)}`;
    }
  });
  socket.addEventListener('close', () => {
    release();
    for (const button of buttons) button.disabled = true;
    telemetry.textContent = 'Waiting for car telemetry';
    connection.textContent = 'Controller disconnected. Reopen the link from the desktop.';
  });
}
