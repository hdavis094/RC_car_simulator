// The network-dropout scenario (docs/tasks/P3-02-network-faults.md):
// the real starter firmware receives a held manual drive stream, drives the car
// forward, then experiences a network dropout and triggers the 500 ms manual
// failsafe to neutralize throttle and steering in deterministic sim time.
//
//   node scenarios/network-dropout.ts
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFirmwareSource,
  parseAssertion,
  runScenario,
  type ActuatorSource,
  type ActuatorSourceSetup,
  type ScenarioResult,
  type ScenarioSpec,
  type TickInput,
  type TickOutput,
} from '@rcsim/sim-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const template = path.join(repo, 'packages', 'firmware-template');
const buildSim = path.join(repo, 'packages', 'hal', 'bin', 'build-sim');

const PROJECT_ENTRIES = ['car.json', 'platformio.ini', 'include', 'src'];
const NEUTRAL_PULSE_US = 1500;
const FAILSAFE_SERIAL_MARKER = 'failsafe: no drive for 500 ms';

type NetFaultsValue = NonNullable<TickInput['netFaults']>;

export interface ScheduledNetFault {
  readonly tUs: number;
  readonly faults: NetFaultsValue;
}

export interface NetworkDropoutTrace {
  readonly dropoutAtUs: number;
  readonly escPulseBeforeDropoutUs: number | null;
  readonly steerPulseBeforeDropoutUs: number | null;
  readonly escPulseMidWindowUs: number | null;
  readonly steerPulseMidWindowUs: number | null;
  readonly failsafeNeutralAtUs: number | null;
  readonly failsafeLoggedAtUs: number | null;
  readonly postFailsafeMaxEscDeltaUs: number;
  readonly postFailsafeMaxSteerDeltaUs: number;
  readonly finalEscPulseUs: number | null;
  readonly finalSteerPulseUs: number | null;
}

export interface NetworkDropoutResult {
  readonly scenario: ScenarioResult;
  readonly trace: NetworkDropoutTrace;
}

let firmware: Promise<string> | undefined;

function buildFirmware(): Promise<string> {
  firmware ??= Promise.resolve().then(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rcsim-net-dropout-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    for (const entry of PROJECT_ENTRIES) {
      cpSync(path.join(template, entry), path.join(dir, entry), { recursive: true });
    }
    const built = spawnSync(process.execPath, [buildSim, dir], { encoding: 'utf8' });
    if (built.error) throw built.error;
    if (built.status !== 0) {
      throw new Error(`build-sim failed (${built.status}):\n${built.stdout}${built.stderr}`);
    }
    return path.join(dir, '.rcsim', 'build', 'firmware');
  });
  return firmware;
}

function withNetFaultTrace(
  inner: ActuatorSource,
  schedule: readonly ScheduledNetFault[],
  dropoutAtUs: number,
  onTrace: (trace: NetworkDropoutTrace) => void,
): ActuatorSource {
  const ordered = [...schedule].sort((a, b) => a.tUs - b.tUs);
  let nextFaultIndex = 0;
  let escGpio = -1;
  let steerGpio = -1;
  let currentEscPulseUs: number | null = null;
  let currentSteerPulseUs: number | null = null;
  let escPulseBeforeDropoutUs: number | null = null;
  let steerPulseBeforeDropoutUs: number | null = null;
  let escPulseMidWindowUs: number | null = null;
  let steerPulseMidWindowUs: number | null = null;
  let failsafeNeutralAtUs: number | null = null;
  let failsafeLoggedAtUs: number | null = null;
  let postFailsafeMaxEscDeltaUs = 0;
  let postFailsafeMaxSteerDeltaUs = 0;
  const decoder = new TextDecoder();
  let serialBuffer = '';

  const snapshotTrace = (): NetworkDropoutTrace => ({
    dropoutAtUs,
    escPulseBeforeDropoutUs,
    steerPulseBeforeDropoutUs,
    escPulseMidWindowUs,
    steerPulseMidWindowUs,
    failsafeNeutralAtUs,
    failsafeLoggedAtUs,
    postFailsafeMaxEscDeltaUs,
    postFailsafeMaxSteerDeltaUs,
    finalEscPulseUs: currentEscPulseUs,
    finalSteerPulseUs: currentSteerPulseUs,
  });

  return {
    async start(setup: ActuatorSourceSetup): Promise<void> {
      escGpio =
        setup.devices.find((d) => d.kind === 'esc')?.pins.find((p) => p.name === 'SIGNAL')?.gpio ??
        -1;
      steerGpio =
        setup.devices.find((d) => d.kind === 'servo')?.pins.find((p) => p.name === 'SIGNAL')
          ?.gpio ?? -1;
      if (escGpio < 0 || steerGpio < 0) {
        throw new Error('Expected wired ESC and steering servo in starter car.json.');
      }
      await inner.start(setup);
    },

    async step(input: TickInput): Promise<TickOutput> {
      let netFaults = input.netFaults;
      while (nextFaultIndex < ordered.length && ordered[nextFaultIndex]!.tUs <= input.t0Us) {
        netFaults = ordered[nextFaultIndex]!.faults;
        nextFaultIndex += 1;
      }

      const output = await inner.step(netFaults !== undefined ? { ...input, netFaults } : input);

      for (const pwm of output.pwm) {
        if (pwm.gpio === escGpio) currentEscPulseUs = pwm.pulseUs;
        if (pwm.gpio === steerGpio) currentSteerPulseUs = pwm.pulseUs;
      }

      if (output.serialTx.length > 0 && failsafeLoggedAtUs === null) {
        serialBuffer += decoder.decode(output.serialTx, { stream: true });
        if (serialBuffer.includes(FAILSAFE_SERIAL_MARKER)) {
          failsafeLoggedAtUs = input.t0Us;
        } else if (serialBuffer.length > 256) {
          serialBuffer = serialBuffer.slice(-256);
        }
      }

      if (input.t0Us < dropoutAtUs) {
        escPulseBeforeDropoutUs = currentEscPulseUs;
        steerPulseBeforeDropoutUs = currentSteerPulseUs;
      } else {
        if (input.t0Us === dropoutAtUs + 400_000) {
          escPulseMidWindowUs = currentEscPulseUs;
          steerPulseMidWindowUs = currentSteerPulseUs;
        }
        if (
          failsafeNeutralAtUs === null &&
          currentEscPulseUs === NEUTRAL_PULSE_US &&
          currentSteerPulseUs === NEUTRAL_PULSE_US
        ) {
          failsafeNeutralAtUs = input.t0Us;
        } else if (failsafeNeutralAtUs !== null) {
          if (currentEscPulseUs !== null) {
            postFailsafeMaxEscDeltaUs = Math.max(
              postFailsafeMaxEscDeltaUs,
              Math.abs(currentEscPulseUs - NEUTRAL_PULSE_US),
            );
          }
          if (currentSteerPulseUs !== null) {
            postFailsafeMaxSteerDeltaUs = Math.max(
              postFailsafeMaxSteerDeltaUs,
              Math.abs(currentSteerPulseUs - NEUTRAL_PULSE_US),
            );
          }
        }
      }

      return output;
    },

    async stop(): Promise<void> {
      onTrace(snapshotTrace());
      await inner.stop();
    },
  };
}

interface NetworkDropoutFile extends Omit<ScenarioSpec, 'assertions' | 'firmware'> {
  readonly dropoutAtUs: number;
  readonly assertions: readonly string[];
}

export async function runNetworkDropout(
  options: { readonly seed?: number } = {},
): Promise<NetworkDropoutResult> {
  const file = JSON.parse(
    readFileSync(path.join(here, 'network-dropout.json'), 'utf8'),
  ) as NetworkDropoutFile;
  const binary = await buildFirmware();
  const spec: ScenarioSpec = {
    car: file.car,
    world: file.world,
    seconds: file.seconds,
    seed: options.seed ?? file.seed,
    ...(file.control !== undefined ? { control: file.control } : {}),
    firmware: binary,
    assertions: file.assertions.map(parseAssertion),
  };

  let trace: NetworkDropoutTrace | undefined;
  const scenario = await runScenario(spec, {
    cwd: here,
    createFirmwareSource: () =>
      withNetFaultTrace(
        createFirmwareSource({ binary }),
        [
          {
            tUs: file.dropoutAtUs,
            faults: { latencyUs: 0, lossPpm: 0, dropout: true },
          },
        ],
        file.dropoutAtUs,
        (captured) => {
          trace = captured;
        },
      ),
  });

  if (!trace) throw new Error('Network dropout trace was not recorded.');
  return { scenario, trace };
}

async function main(): Promise<number> {
  const { scenario, trace } = await runNetworkDropout({ seed: 1 });
  console.log(
    JSON.stringify({
      passed: scenario.passed,
      end: scenario.end,
      metrics: scenario.metrics,
      trace,
      serialHash: scenario.serialHash,
      snapshotHash: scenario.snapshotHash,
      wallMs: scenario.wallMs,
    }),
  );
  if (
    !scenario.passed ||
    scenario.end.kind !== 'stopped' ||
    trace.escPulseBeforeDropoutUs === null ||
    trace.escPulseBeforeDropoutUs <= NEUTRAL_PULSE_US ||
    trace.failsafeNeutralAtUs === null ||
    trace.failsafeLoggedAtUs === null ||
    trace.postFailsafeMaxEscDeltaUs !== 0 ||
    trace.postFailsafeMaxSteerDeltaUs !== 0
  ) {
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
