import type { Catalog } from '../catalog.ts';
import type { Car } from '../car.ts';
import { hex } from '../common.ts';
import {
  INPUT_KINDS,
  electricalOf,
  type I2cInfo,
  type PinDefinition,
  type PinKind,
} from '../part-definition.ts';
import { headerMacros } from '../car-config-header.ts';
import type { Issue, IssueRef, WiringRuleId } from './issue.ts';
import { DRIVING_KINDS, Netlist, type Net, type ResolvedPart } from './netlist.ts';

/** Kinds the controller has to drive, which an input-only GPIO cannot. */
const CONTROLLER_DRIVES: ReadonlySet<PinKind> = new Set([
  'digital-in',
  'pwm-in',
  'i2c-sda',
  'i2c-scl',
]);

const fmtV = (v: number): string => `${Number(v.toFixed(2))} V`;
const pinRef = (part: ResolvedPart, pin: string): IssueRef => ({
  part: part.instance.instanceId,
  pin,
});
const label = (part: ResolvedPart, pin: string): string => `${part.instance.instanceId}.${pin}`;

function issue(
  severity: Issue['severity'],
  rule: WiringRuleId,
  message: string,
  refs: IssueRef[],
): Issue {
  return { severity, rule, message, refs };
}

/** The controller's ADC1 GPIOs, for advice in messages. */
const adc1Gpios = (netlist: Netlist): string =>
  (netlist.controller?.definition.gpios ?? [])
    .filter((g) => g.adc1Channel !== undefined)
    .map((g) => g.gpio)
    .sort((a, b) => a - b)
    .join(', ');

/** Pins on a net other than ground. */
const signalPins = (net: Net) => net.pins.filter((member) => member.pin.kind !== 'gnd');

function gpioRules(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];
  for (const net of netlist.nets()) {
    if (net.gpios.length === 0) continue;
    const members = signalPins(net);
    const memberRefs = members.map((m) => pinRef(m.part, m.pin.name));
    const names = members.map((m) => label(m.part, m.pin.name)).join(', ');

    // A net never holds two GPIOs: every pin declares at most one wire, so
    // joining two GPIOs would need more wires than the pins in between have.

    for (const gpio of net.gpios) {
      const at = { gpio: gpio.gpio };
      const kinds = new Set(members.map((m) => m.pin.kind));
      const sharedBus = kinds.size === 1 && (kinds.has('i2c-sda') || kinds.has('i2c-scl'));
      if (members.length > 1 && !sharedBus) {
        issues.push(
          issue('error', 'pin-conflict', `GPIO ${gpio.gpio} is used by ${names}`, [
            at,
            ...memberRefs,
          ]),
        );
      }
      if (gpio.flash) {
        issues.push(
          issue(
            'error',
            'flash-pin',
            `GPIO ${gpio.gpio} is wired to the module flash and can't be used (${names})`,
            [at, ...memberRefs],
          ),
        );
      }
      if (gpio.uart0) {
        issues.push(
          issue(
            'error',
            'uart0-pin',
            `GPIO ${gpio.gpio} is UART0 ${gpio.uart0.toUpperCase()}, used by the USB serial monitor (${names})`,
            [at, ...memberRefs],
          ),
        );
      }
      if (gpio.strapping) {
        issues.push(
          issue(
            'warning',
            'strapping-pin',
            `GPIO ${gpio.gpio} is a strapping pin: what ${names} does to it at reset can change the boot mode`,
            [at, ...memberRefs],
          ),
        );
      }
      for (const m of members) {
        if (gpio.inputOnly && CONTROLLER_DRIVES.has(m.pin.kind)) {
          issues.push(
            issue(
              'error',
              'input-only-output',
              `GPIO ${gpio.gpio} is input-only, but ${label(m.part, m.pin.name)} (${m.pin.kind}) needs the controller to drive it`,
              [at, pinRef(m.part, m.pin.name)],
            ),
          );
        }
        if (netlist.isAnalog(m.part, m.pin)) {
          const adc1 = gpio.adc1Channel !== undefined;
          const adc2 = gpio.adc2Channel !== undefined;
          if (!adc1 && !adc2) {
            issues.push(
              issue(
                'error',
                'no-adc',
                `GPIO ${gpio.gpio} has no ADC, so it can't read the analog ${label(m.part, m.pin.name)}`,
                [at, pinRef(m.part, m.pin.name)],
              ),
            );
          } else if (!adc1 && netlist.car.wifi) {
            issues.push(
              issue(
                'error',
                'adc2-wifi',
                `GPIO ${gpio.gpio} is on ADC2, which is unavailable while Wi-Fi is on; move ${label(m.part, m.pin.name)} to an ADC1 pin (GPIO ${adc1Gpios(netlist)})`,
                [at, pinRef(m.part, m.pin.name)],
              ),
            );
          }
        }
      }

      const maxInputV = netlist.controller?.definition.gpioMaxInputV;
      const voltage = netlist.netVoltage(net);
      if (maxInputV !== undefined && voltage && voltage.max > maxInputV + 1e-9) {
        const drivers = members.filter((m) => {
          if (!DRIVING_KINDS.has(m.pin.kind)) return false;
          const v = netlist.pinVoltage(m.part, m.pin);
          return v !== undefined && v.max > maxInputV;
        });
        issues.push(
          issue(
            'error',
            'level-mismatch',
            `${drivers.map((m) => label(m.part, m.pin.name)).join(', ') || names} puts ${fmtV(voltage.max)} on GPIO ${gpio.gpio}, which accepts at most ${fmtV(maxInputV)}; add a level shifter or divider`,
            [at, ...drivers.map((m) => pinRef(m.part, m.pin.name))],
          ),
        );
      }
    }
  }
  return issues;
}

/** The highest voltage an input pin tolerates, if the part says. */
function inputToleranceV(
  netlist: Netlist,
  part: ResolvedPart,
  pin: PinDefinition,
): number | undefined {
  if (pin.maxInputV !== undefined) return pin.maxInputV;
  if (pin.kind === 'analog-in' && pin.voltage === undefined) return undefined; // a divider input
  return netlist.pinVoltage(part, pin)?.max;
}

/** Inputs of parts driven above what they tolerate, on any net (GPIO nets included). */
function inputLevels(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];
  for (const part of netlist.parts) {
    if (part === netlist.controller) continue;
    for (const pin of part.definition.pins) {
      if (!INPUT_KINDS.has(pin.kind)) continue;
      const net = netlist.netOfPin(part, pin.name);
      if (!net) continue;
      const tolerance = inputToleranceV(netlist, part, pin);
      const voltage = netlist.lineVoltage(net, { part, pinName: pin.name });
      if (tolerance === undefined || voltage === undefined || voltage <= tolerance + 1e-9) continue;
      issues.push(
        issue(
          'error',
          'level-mismatch',
          `${label(part, pin.name)} tolerates ${fmtV(tolerance)} but its line reaches ${fmtV(voltage)}`,
          [pinRef(part, pin.name), ...net.gpios.map((g) => ({ gpio: g.gpio }))],
        ),
      );
    }
  }
  return issues;
}

function railConflicts(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];
  for (const net of netlist.nets()) {
    const grounds = net.pins.filter((m) => m.pin.kind === 'gnd');
    const outputs = net.pins.filter(
      (m) => m.pin.kind === 'digital-out' || m.pin.kind === 'analog-out',
    );
    const sources = net.pins.filter((m) => m.pin.kind === 'power-out');
    if (grounds.length > 0 && sources.length === 0) {
      for (const gpio of net.gpios) {
        issues.push(
          issue('error', 'rail-conflict', `GPIO ${gpio.gpio} is wired straight to ground`, [
            { gpio: gpio.gpio },
            ...grounds.map((m) => pinRef(m.part, m.pin.name)),
          ]),
        );
      }
      for (const m of outputs) {
        issues.push(
          issue(
            'error',
            'rail-conflict',
            `the output ${label(m.part, m.pin.name)} is shorted to ground`,
            [pinRef(m.part, m.pin.name)],
          ),
        );
      }
    }
    if (sources.length === 0) continue;
    for (const m of outputs) {
      issues.push(
        issue(
          'error',
          'rail-conflict',
          `the output ${label(m.part, m.pin.name)} is wired to the rail ${sources.map((src) => label(src.part, src.pin.name)).join(', ')} and would fight it`,
          [pinRef(m.part, m.pin.name), ...sources.map((src) => pinRef(src.part, src.pin.name))],
        ),
      );
    }
    const refs = sources.map((m) => pinRef(m.part, m.pin.name));
    const names = sources.map((m) => label(m.part, m.pin.name)).join(' and ');
    if (sources.length > 1) {
      issues.push(
        issue('error', 'rail-conflict', `${names} are power outputs wired together`, refs),
      );
    }
    if (grounds.length > 0) {
      issues.push(
        issue('error', 'rail-conflict', `${names} is shorted to ground`, [
          ...refs,
          ...grounds.map((m) => pinRef(m.part, m.pin.name)),
        ]),
      );
    }
    for (const gpio of net.gpios) {
      issues.push(
        issue('error', 'rail-conflict', `${names} is wired straight to GPIO ${gpio.gpio}`, [
          ...refs,
          { gpio: gpio.gpio },
        ]),
      );
    }
  }
  return issues;
}

function supplyVoltage(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];
  for (const part of netlist.parts) {
    const supply = electricalOf(part.definition)?.supplyV;
    if (!supply) continue;
    for (const pin of part.definition.pins) {
      if (pin.kind !== 'power-in') continue;
      const net = netlist.netOfPin(part, pin.name);
      if (!net) continue;
      const voltage = netlist.netVoltage(net);
      if (!voltage) {
        issues.push(
          issue(
            'error',
            'supply-voltage',
            `${label(part, pin.name)} is wired, but nothing on that wire supplies power`,
            [pinRef(part, pin.name)],
          ),
        );
        continue;
      }
      if (voltage.min < supply.min - 1e-9 || voltage.max > supply.max + 1e-9) {
        const range =
          voltage.min === voltage.max
            ? fmtV(voltage.max)
            : `${fmtV(voltage.min)}–${fmtV(voltage.max)}`;
        issues.push(
          issue(
            'error',
            'supply-voltage',
            `${label(part, pin.name)} gets ${range}, outside its ${fmtV(supply.min)}–${fmtV(supply.max)} supply range`,
            [pinRef(part, pin.name)],
          ),
        );
      }
    }
  }
  return issues;
}

type Load = 'typical' | 'peak';

/** Current a part draws on its power-in pin, including what its own outputs supply. */
function drawMa(netlist: Netlist, part: ResolvedPart, load: Load, seen: Set<ResolvedPart>): number {
  if (seen.has(part)) return 0;
  seen.add(part);
  const definition = part.definition;
  let total = electricalOf(definition)?.currentMa[load] ?? 0;
  for (const pin of definition.pins) {
    if (pin.kind !== 'power-out') continue;
    const downstream = railLoadMa(netlist, part, pin.name, load, seen);
    if (downstream === 0) continue;
    let factor = 1;
    if (
      'behavior' in definition &&
      definition.behavior.template === 'regulator' &&
      definition.behavior.params.topology === 'buck'
    ) {
      const powerIn = definition.pins.find((p) => p.kind === 'power-in');
      const inNet = powerIn && netlist.netOfPin(part, powerIn.name);
      const inV = inNet && netlist.netVoltage(inNet);
      const efficiency = (definition.behavior.params.efficiencyPct ?? 85) / 100;
      if (inV && inV.min > 0) factor = definition.behavior.params.outputV / (inV.min * efficiency);
    }
    total += downstream * factor;
  }
  return total;
}

/** Current drawn from one power-out pin by everything powered from it. */
function railLoadMa(
  netlist: Netlist,
  source: ResolvedPart,
  pinName: string,
  load: Load,
  seen: Set<ResolvedPart>,
): number {
  const net = netlist.netOfPin(source, pinName);
  if (!net) return 0;
  let total = 0;
  for (const member of net.pins) {
    if (member.pin.kind !== 'power-in' || member.part === source) continue;
    total += drawMa(netlist, member.part, load, seen);
  }
  return total;
}

function railBudget(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];
  for (const part of netlist.parts) {
    for (const pin of part.definition.pins) {
      if (pin.kind !== 'power-out' || pin.maxCurrentMa === undefined) continue;
      const typical = railLoadMa(netlist, part, pin.name, 'typical', new Set([part]));
      const peak = railLoadMa(netlist, part, pin.name, 'peak', new Set([part]));
      const budget = pin.maxCurrentMa;
      if (typical > budget) {
        issues.push(
          issue(
            'error',
            'rail-over-budget',
            `${label(part, pin.name)} supplies ${Math.round(typical)} mA typical, over its ${budget} mA budget`,
            [pinRef(part, pin.name)],
          ),
        );
      } else if (peak > budget) {
        issues.push(
          issue(
            'warning',
            'rail-over-budget',
            `${label(part, pin.name)} may need ${Math.round(peak)} mA at peak, over its ${budget} mA budget; the supply may brown out`,
            [pinRef(part, pin.name)],
          ),
        );
      }
    }
  }
  return issues;
}

/** Whether a strap pin is held high (by a rail), low (ground or open), or by a GPIO. */
function strapLevel(netlist: Netlist, part: ResolvedPart, pin: string): 'high' | 'low' | 'gpio' {
  const net = netlist.netOfPin(part, pin);
  if (!net) return 'low';
  if (net.gpios.length > 0) return 'gpio';
  if (net.pins.some((m) => m.pin.kind === 'power-out')) return 'high';
  // Driven by another part's output: its level can change, as with a GPIO.
  if (net.pins.some((m) => m.pin.kind === 'digital-out' || m.pin.kind === 'analog-out'))
    return 'gpio';
  return 'low';
}

function i2cRules(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];
  const buses = new Map<string, I2cDevice[]>();

  for (const part of netlist.parts) {
    const definition = part.definition;
    const id = part.instance.instanceId;
    const i2c = 'i2c' in definition ? definition.i2c : undefined;
    if (!i2c) {
      if (part.instance.i2cAddress !== undefined) {
        issues.push(
          issue('error', 'reference', `${id}: "${definition.id}" is not an I²C part`, [
            { part: id },
          ]),
        );
      }
      continue;
    }

    const address = part.instance.i2cAddress ?? i2c.defaultAddress;
    const addressing = i2c.addressing;
    if (addressing.kind === 'fixed' && address !== i2c.defaultAddress) {
      issues.push(
        issue(
          'error',
          'i2c-address-invalid',
          `${id} has the fixed address ${hex(i2c.defaultAddress)}; it can't use ${hex(address)}`,
          [{ part: id }],
        ),
      );
    }
    if (addressing.kind === 'strap') {
      const index = addressing.addresses.indexOf(address);
      if (index < 0) {
        issues.push(
          issue(
            'error',
            'i2c-address-invalid',
            `${id} can only use ${addressing.addresses.map(hex).join(' or ')}, not ${hex(address)}`,
            [{ part: id }],
          ),
        );
      } else {
        const level = strapLevel(netlist, part, addressing.pin);
        const wanted = index === 0 ? 'low' : 'high';
        if (level !== 'gpio' && level !== wanted) {
          issues.push(
            issue(
              'error',
              'i2c-address-unreachable',
              `${id} answers at ${hex(address)} only with ${addressing.pin} ${wanted}, but it is ${level}`,
              [pinRef(part, addressing.pin)],
            ),
          );
        }
      }
    }
    const sdaPin = definition.pins.find((p) => p.kind === 'i2c-sda');
    const sclPin = definition.pins.find((p) => p.kind === 'i2c-scl');
    const sda = sdaPin && netlist.gpioOfPin(part, sdaPin.name);
    const scl = sclPin && netlist.gpioOfPin(part, sclPin.name);
    if ((sda === undefined) !== (scl === undefined)) {
      const missing = sda === undefined ? sdaPin : sclPin;
      issues.push(
        issue(
          'error',
          'i2c-incomplete',
          `${id} has only one I²C line on a GPIO; wire ${missing?.name ?? 'both lines'} too`,
          [missing ? pinRef(part, missing.name) : { part: id }],
        ),
      );
    }
    const wired = [sdaPin, sclPin].some((p) => p && netlist.netOfPin(part, p.name));
    if (sda === undefined && scl === undefined && wired) {
      issues.push(
        issue(
          'error',
          'i2c-incomplete',
          `${id}'s I²C lines are wired, but neither reaches a controller GPIO, so the firmware can never talk to it`,
          [sdaPin ? pinRef(part, sdaPin.name) : { part: id }],
        ),
      );
    }
    if (sda !== undefined && scl !== undefined) {
      const key = `${sda}/${scl}`;
      const bus = buses.get(key) ?? [];
      bus.push({ part, address, boot: i2c.defaultAddress, addressing });
      buses.set(key, bus);
    }
  }

  // A GPIO that is SDA (or SCL) for two different buses joins them.
  for (const line of ['SDA', 'SCL'] as const) {
    const partners = new Map<string, Set<string>>();
    for (const key of buses.keys()) {
      const [sda, scl] = key.split('/') as [string, string];
      const [mine, other] = line === 'SDA' ? [sda, scl] : [scl, sda];
      partners.set(mine, new Set([...(partners.get(mine) ?? []), other]));
    }
    for (const [gpio, others] of partners) {
      if (others.size < 2) continue;
      const otherLine = line === 'SDA' ? 'SCL' : 'SDA';
      issues.push(
        issue(
          'error',
          'pin-conflict',
          `GPIO ${gpio} is ${line} for I²C parts whose ${otherLine} is on different GPIOs (${[...others].join(', ')}); a bus needs one SDA and one SCL`,
          [{ gpio: Number(gpio) }],
        ),
      );
    }
  }

  for (const devices of buses.values()) issues.push(...bootAddressRule(netlist, devices));

  // An enable pin tied to ground holds the part in standby for good.
  for (const devices of buses.values()) {
    for (const d of devices) {
      if (d.addressing.kind !== 'software') continue;
      const net = netlist.netOfPin(d.part, d.addressing.enablePin);
      if (!net || net.gpios.length > 0 || !net.pins.some((m) => m.pin.kind === 'gnd')) continue;
      issues.push(
        issue(
          'error',
          'i2c-address-unreachable',
          `${d.part.instance.instanceId}.${d.addressing.enablePin} is tied to ground, which holds the part in standby so it never answers; wire it to a GPIO or leave it open`,
          [pinRef(d.part, d.addressing.enablePin)],
        ),
      );
    }
  }

  for (const [key, devices] of buses) {
    const byAddress = new Map<number, ResolvedPart[]>();
    for (const { part, address } of devices) {
      byAddress.set(address, [...(byAddress.get(address) ?? []), part]);
    }
    for (const [address, parts] of byAddress) {
      if (parts.length < 2) continue;
      const [sda, scl] = key.split('/');
      issues.push(
        issue(
          'error',
          'i2c-address-clash',
          `${parts.map((p) => p.instance.instanceId).join(', ')} all use ${hex(address)} on the I²C bus SDA ${sda}/SCL ${scl}`,
          parts.map((p) => ({ part: p.instance.instanceId })),
        ),
      );
    }
  }
  return issues;
}

interface I2cDevice {
  readonly part: ResolvedPart;
  readonly address: number;
  readonly boot: number;
  readonly addressing: I2cInfo['addressing'];
}

/**
 * Software-addressed parts (VL53L0X) all boot at the same address. When two
 * or more devices on a bus answer at that boot address, the firmware has to
 * hold every software-addressed one but one off the bus with its enable pin
 * (none, if a fixed device also sits there), then re-address them in turn.
 */
function bootAddressRule(netlist: Netlist, devices: readonly I2cDevice[]): Issue[] {
  const issues: Issue[] = [];
  const boots = new Set(devices.filter((d) => d.addressing.kind === 'software').map((d) => d.boot));
  for (const boot of boots) {
    const software = devices.filter((d) => d.addressing.kind === 'software' && d.boot === boot);
    const others = devices.filter((d) => d.addressing.kind !== 'software' && d.address === boot);
    if (software.length + others.length < 2) continue;
    const isolated = (d: I2cDevice): boolean =>
      d.addressing.kind === 'software' &&
      netlist.gpioOfPin(d.part, d.addressing.enablePin) !== undefined;
    const stuck = software.filter((d) => !isolated(d));
    if (others.length > 0) {
      for (const d of software) {
        issues.push(
          issue(
            'error',
            'i2c-address-unreachable',
            `${d.part.instance.instanceId} boots at ${hex(boot)}, where ${others.map((o) => o.part.instance.instanceId).join(', ')} also sits, so it can never be re-addressed; move it to another bus`,
            [{ part: d.part.instance.instanceId }],
          ),
        );
      }
      continue;
    }
    // The one unisolated device is re-addressed first, while the others are
    // held off; it must leave the boot address so they can come up after it.
    const allowed = 1;
    const lastStuckMoves = stuck.length === 0 || stuck[0]?.address !== boot;
    if (stuck.length <= allowed && lastStuckMoves) continue;
    for (const d of stuck) {
      const pin = d.addressing.kind === 'software' ? d.addressing.enablePin : '';
      issues.push(
        issue(
          'error',
          'i2c-address-unreachable',
          `${d.part.instance.instanceId} boots at ${hex(boot)} along with ${software.length + others.length - 1} other device(s) on its bus; wire ${pin} to a GPIO so the firmware can hold it off the bus while it re-addresses the others`,
          [pinRef(d.part, pin)],
        ),
      );
    }
  }
  return issues;
}

/** Generated header macros that two pins or parts would both define. */
function macroClashes(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];
  const seen = new Map<string, IssueRef>();
  for (const macro of headerMacros(netlist)) {
    const first = seen.get(macro.name);
    if (first) {
      issues.push(
        issue(
          'error',
          'macro-clash',
          `${macro.name} would be defined twice in car_config.h; rename an instance id`,
          [first, macro.ref],
        ),
      );
    } else {
      seen.set(macro.name, macro.ref);
    }
  }
  return issues;
}

/** Pins the part needs that nothing is wired to. Ground is common and never reported. */
function unconnectedPins(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];
  for (const part of netlist.parts) {
    for (const pin of part.definition.pins) {
      if (pin.optional || pin.kind === 'gnd' || pin.kind === 'power-out') continue;
      if (netlist.netOfPin(part, pin.name)) continue;
      issues.push(
        issue('warning', 'unconnected-pin', `${label(part, pin.name)} (${pin.kind}) is not wired`, [
          pinRef(part, pin.name),
        ]),
      );
    }
  }
  return issues;
}

function placementRules(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];
  const chassis = netlist.chassis;
  for (const part of netlist.parts) {
    const id = part.instance.instanceId;
    const placement = part.instance.placement;
    const definition = part.definition;
    const needsPlacement =
      'behavior' in definition &&
      (definition.behavior.template === 'distance-raycast' ||
        definition.behavior.template === 'imu');
    if (!placement) {
      if (needsPlacement) {
        issues.push(
          issue('error', 'placement', `${id} is a sensor and needs a mount point`, [{ part: id }]),
        );
      }
      continue;
    }
    if (chassis && !chassis.mountPoints.some((mount) => mount.id === placement.mount)) {
      issues.push(
        issue(
          'error',
          'placement',
          `${id} is placed on "${placement.mount}", which "${chassis.id}" doesn't have (it has ${chassis.mountPoints.map((m) => m.id).join(', ')})`,
          [{ part: id }],
        ),
      );
    }
  }
  return issues;
}

/**
 * Checks a car's pin assignments and placement against its part definitions.
 * Issues come out in a stable order: rule by rule, then in car.json order.
 */
export function checkWiring(car: Car, catalog: Catalog): Issue[] {
  const netlist = new Netlist(car, catalog);
  return [
    ...netlist.referenceIssues,
    ...netlist.wireIssues,
    ...railConflicts(netlist),
    ...gpioRules(netlist),
    ...inputLevels(netlist),
    ...supplyVoltage(netlist),
    ...railBudget(netlist),
    ...i2cRules(netlist),
    ...unconnectedPins(netlist),
    ...placementRules(netlist),
    ...macroClashes(netlist),
  ];
}

/** True when no issue is an error, so the car may run. */
export function canRun(issues: readonly Issue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}
