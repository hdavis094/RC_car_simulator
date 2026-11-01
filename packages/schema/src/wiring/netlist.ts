import { dividerRatio } from '../behavior.ts';
import type { Car, Part } from '../car.ts';
import type { Catalog } from '../catalog.ts';
import { electricalOf, findPin } from '../part-definition.ts';
import type {
  ChassisDefinition,
  ControllerDefinition,
  GpioDefinition,
  PartDefinition,
  PinDefinition,
  PinKind,
} from '../part-definition.ts';
import type { Issue } from './issue.ts';

/** A part instance together with its definition. */
export interface ResolvedPart {
  readonly instance: Part;
  readonly definition: PartDefinition;
}

/** One end of a wire. */
export type Endpoint =
  | { readonly type: 'gpio'; readonly gpio: number }
  | { readonly type: 'pin'; readonly part: ResolvedPart; readonly pin: PinDefinition };

/** A set of endpoints wired together. */
export interface Net {
  readonly gpios: readonly GpioDefinition[];
  readonly pins: readonly { readonly part: ResolvedPart; readonly pin: PinDefinition }[];
}

export interface VoltageRange {
  readonly min: number;
  readonly max: number;
}

/** Kinds that can be wired straight to a controller GPIO. */
const GPIO_KINDS: ReadonlySet<PinKind> = new Set([
  'digital-in',
  'digital-out',
  'pwm-in',
  'i2c-sda',
  'i2c-scl',
  'analog-out',
]);

/** Kinds that may be wired to each other between two parts (unordered pairs). */
const PART_TO_PART: readonly (readonly [PinKind, PinKind])[] = [
  ['power-in', 'power-out'],
  ['gnd', 'gnd'],
  ['analog-in', 'power-out'],
  ['analog-in', 'digital-out'],
  ['analog-in', 'analog-out'],
  ['digital-in', 'power-out'],
  ['digital-in', 'gnd'],
  ['digital-in', 'digital-out'],
  ['digital-in', 'analog-out'],
  ['i2c-sda', 'i2c-sda'],
  ['i2c-scl', 'i2c-scl'],
];

/** Kinds that set the voltage of the line they are on. */
export const DRIVING_KINDS: ReadonlySet<PinKind> = new Set([
  'power-out',
  'digital-out',
  'analog-out',
  'i2c-sda',
  'i2c-scl',
]);

export function canWireToGpio(kind: PinKind): boolean {
  return GPIO_KINDS.has(kind);
}

export function canWirePins(a: PinKind, b: PinKind): boolean {
  return PART_TO_PART.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

const endpointKey = (endpoint: Endpoint): string =>
  endpoint.type === 'gpio'
    ? `gpio:${endpoint.gpio}`
    : `pin:${endpoint.part.instance.instanceId}/${endpoint.pin.name}`;

/**
 * The resolved wiring of a car: parts with their definitions, and the nets
 * their pin assignments form. Building it reports every broken reference.
 */
export class Netlist {
  readonly car: Car;
  readonly controller: (ResolvedPart & { readonly definition: ControllerDefinition }) | undefined;
  readonly chassis: ChassisDefinition | undefined;
  /** Controller first, then car.parts in order; only parts whose definition was found. */
  readonly parts: readonly ResolvedPart[];
  readonly referenceIssues: Issue[] = [];
  readonly wireIssues: Issue[] = [];

  readonly #byId = new Map<string, ResolvedPart>();
  readonly #parent = new Map<string, string>();
  readonly #endpoints = new Map<string, Endpoint>();
  #nets: Map<string, Net> | undefined;

  constructor(car: Car, catalog: Catalog) {
    this.car = car;
    const controllerDef = catalog.get(car.controller.partId);
    if (!controllerDef) {
      this.#reference(car.controller.instanceId, `unknown part "${car.controller.partId}"`);
    } else if (controllerDef.category !== 'controller') {
      this.#reference(car.controller.instanceId, `"${controllerDef.id}" is not a controller`);
    }
    this.controller =
      controllerDef?.category === 'controller'
        ? { instance: car.controller, definition: controllerDef }
        : undefined;

    const chassisDef = catalog.get(car.chassis.partId);
    if (!chassisDef) {
      this.#reference(car.chassis.instanceId, `unknown part "${car.chassis.partId}"`);
    } else if (chassisDef.category !== 'chassis') {
      this.#reference(car.chassis.instanceId, `"${chassisDef.id}" is not a chassis`);
    }
    this.chassis = chassisDef?.category === 'chassis' ? chassisDef : undefined;

    const parts: ResolvedPart[] = [];
    if (this.controller) parts.push(this.controller);
    for (const instance of car.parts) {
      const definition = catalog.get(instance.partId);
      if (!definition) {
        this.#reference(instance.instanceId, `unknown part "${instance.partId}"`);
        continue;
      }
      if (definition.category === 'controller' || definition.category === 'chassis') {
        this.#reference(
          instance.instanceId,
          `"${definition.id}" is a ${definition.category}; a car has exactly one, set at the top of car.json`,
        );
        continue;
      }
      parts.push({ instance, definition });
    }
    this.parts = parts;
    for (const part of parts) this.#byId.set(part.instance.instanceId, part);

    for (const part of parts) this.#addWires(part);
  }

  part(instanceId: string): ResolvedPart | undefined {
    return this.#byId.get(instanceId);
  }

  gpio(gpio: number): GpioDefinition | undefined {
    return this.controller?.definition.gpios.find((g) => g.gpio === gpio);
  }

  /** All nets that contain at least one wire. */
  nets(): readonly Net[] {
    return [...this.#netMap().values()];
  }

  /** The net a part pin is on, or undefined if nothing is wired to it. */
  netOfPin(part: ResolvedPart, pinName: string): Net | undefined {
    const pin = findPin(part.definition, pinName);
    if (!pin) return undefined;
    return this.#netMap().get(this.#find(endpointKey({ type: 'pin', part, pin })));
  }

  /** The GPIO a part pin reaches, directly or through one voltage divider. */
  gpioOfPin(part: ResolvedPart, pinName: string, seen = new Set<string>()): number | undefined {
    const net = this.netOfPin(part, pinName);
    if (!net) return undefined;
    const direct = net.gpios[0];
    if (direct) return direct.gpio;
    const key = `${part.instance.instanceId}/${pinName}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    for (const member of net.pins) {
      if (
        member.part !== part &&
        member.pin.name === 'IN' &&
        'behavior' in member.part.definition &&
        member.part.definition.behavior.template === 'voltage-divider'
      ) {
        const through = this.gpioOfPin(member.part, 'OUT', seen);
        if (through !== undefined) return through;
      }
    }
    return undefined;
  }

  /**
   * The voltage a pin presents: a power-out's output, a signal's level, or a
   * divider's scaled input. Undefined when it can't be known (unpowered).
   */
  pinVoltage(
    part: ResolvedPart,
    pin: PinDefinition,
    seen = new Set<string>(),
  ): VoltageRange | undefined {
    const key = `${part.instance.instanceId}/${pin.name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);

    const definition = part.definition;
    if (
      'behavior' in definition &&
      definition.behavior.template === 'voltage-divider' &&
      pin.name === 'OUT'
    ) {
      const input = this.netOfPin(part, 'IN');
      const inV = input && this.netVoltage(input, seen, { part, pinName: 'IN' });
      if (!inV) return undefined;
      const ratio = dividerRatio(definition.behavior.params);
      return { min: inV.min * ratio, max: inV.max * ratio };
    }

    const level = pin.voltage ?? electricalOf(definition)?.logicLevelV;
    if (level === undefined) return undefined;
    if (typeof level === 'number') return { min: level, max: level };
    if (typeof level === 'object') return level;

    const powerIn = definition.pins.find((p) => p.kind === 'power-in');
    const supplyNet = powerIn && this.netOfPin(part, powerIn.name);
    return supplyNet && this.netVoltage(supplyNet, seen, { part, pinName: powerIn.name });
  }

  /** The voltage on a net: the widest range over the pins that drive it. */
  netVoltage(
    net: Net,
    seen = new Set<string>(),
    exclude?: { part: ResolvedPart; pinName: string },
  ): VoltageRange | undefined {
    let result: VoltageRange | undefined;
    for (const member of net.pins) {
      if (!DRIVING_KINDS.has(member.pin.kind)) continue;
      if (exclude && member.part === exclude.part && member.pin.name === exclude.pinName) continue;
      const v = this.pinVoltage(member.part, member.pin, new Set(seen));
      if (!v) continue;
      result = result ? { min: Math.min(result.min, v.min), max: Math.max(result.max, v.max) } : v;
    }
    return result;
  }

  /**
   * The highest voltage on a net including the controller's own outputs. A
   * GPIO the controller drives push-pull (for a digital-in or pwm-in pin) is
   * at its logic level. I²C is open-drain: the controller only pulls low, so
   * the line's high level comes from the parts' pull-ups alone. `exclude`
   * leaves one pin out as a driver.
   */
  lineVoltage(net: Net, exclude?: { part: ResolvedPart; pinName: string }): number | undefined {
    let max = this.netVoltage(net, new Set(), exclude)?.max;
    const pushPull = net.pins.some((m) => m.pin.kind === 'digital-in' || m.pin.kind === 'pwm-in');
    const level = this.controller && electricalOf(this.controller.definition)?.logicLevelV;
    if (net.gpios.length > 0 && pushPull && typeof level === 'number') {
      max = Math.max(max ?? 0, level);
    }
    return max;
  }

  /**
   * Whether a pin carries an analog quantity the controller must measure with
   * an ADC. A divider OUT is analog only when what drives its IN is (a rail or
   * an analog output); a divided digital signal, like an HC-SR04 echo, is not.
   */
  isAnalog(part: ResolvedPart, pin: PinDefinition, seen = new Set<string>()): boolean {
    if (pin.kind !== 'analog-out') return false;
    const definition = part.definition;
    if (!('behavior' in definition) || definition.behavior.template !== 'voltage-divider')
      return true;
    const key = part.instance.instanceId;
    if (seen.has(key)) return true;
    seen.add(key);
    const input = this.netOfPin(part, 'IN');
    if (!input) return true;
    const drivers = input.pins.filter(
      (m) => m.part !== part && DRIVING_KINDS.has(m.pin.kind) && !m.pin.kind.startsWith('i2c'),
    );
    if (drivers.length === 0) return true;
    return drivers.some(
      (m) =>
        m.pin.kind === 'power-out' ||
        (m.pin.kind === 'analog-out' && this.isAnalog(m.part, m.pin, seen)),
    );
  }

  #reference(part: string, message: string, pin?: string): void {
    this.referenceIssues.push({
      severity: 'error',
      rule: 'reference',
      message: pin === undefined ? `${part}: ${message}` : `${part}.${pin}: ${message}`,
      refs: [pin === undefined ? { part } : { part, pin }],
    });
  }

  #addWires(part: ResolvedPart): void {
    const id = part.instance.instanceId;
    for (const [pinName, target] of Object.entries(part.instance.pins ?? {})) {
      const pin = findPin(part.definition, pinName);
      if (!pin) {
        this.#reference(id, `"${part.definition.id}" has no pin "${pinName}"`, pinName);
        continue;
      }
      const from: Endpoint = { type: 'pin', part, pin };

      if ('gpio' in target) {
        if (!this.controller) continue;
        if (!this.gpio(target.gpio)) {
          this.#reference(
            id,
            `GPIO ${target.gpio} is not available on "${this.controller.definition.id}"`,
            pinName,
          );
          continue;
        }
        if (!canWireToGpio(pin.kind)) {
          this.wireIssues.push({
            severity: 'error',
            rule: 'pin-kind-mismatch',
            message: `${id}.${pinName} is a ${pin.kind} pin and can't connect to a GPIO`,
            refs: [{ part: id, pin: pinName }, { gpio: target.gpio }],
          });
          continue;
        }
        this.#union(from, { type: 'gpio', gpio: target.gpio });
        continue;
      }

      const other = this.#byId.get(target.part);
      if (!other) {
        this.#reference(id, `wired to unknown part "${target.part}"`, pinName);
        continue;
      }
      if (other === part) {
        this.#reference(id, `wired to its own pin "${target.pin}"`, pinName);
        continue;
      }
      const otherPin = findPin(other.definition, target.pin);
      if (!otherPin) {
        this.#reference(id, `"${other.definition.id}" has no pin "${target.pin}"`, pinName);
        continue;
      }
      if (!canWirePins(pin.kind, otherPin.kind)) {
        this.wireIssues.push({
          severity: 'error',
          rule: 'pin-kind-mismatch',
          message: `${id}.${pinName} (${pin.kind}) can't connect to ${target.part}.${target.pin} (${otherPin.kind})`,
          refs: [
            { part: id, pin: pinName },
            { part: target.part, pin: target.pin },
          ],
        });
        continue;
      }
      this.#union(from, { type: 'pin', part: other, pin: otherPin });
    }
  }

  #find(key: string): string {
    let root = key;
    while (this.#parent.has(root) && this.#parent.get(root) !== root) {
      root = this.#parent.get(root) as string;
    }
    return root;
  }

  #union(a: Endpoint, b: Endpoint): void {
    this.#nets = undefined;
    for (const endpoint of [a, b]) {
      const key = endpointKey(endpoint);
      if (!this.#parent.has(key)) {
        this.#parent.set(key, key);
        this.#endpoints.set(key, endpoint);
      }
    }
    const rootA = this.#find(endpointKey(a));
    const rootB = this.#find(endpointKey(b));
    if (rootA !== rootB) this.#parent.set(rootB, rootA);
  }

  #netMap(): Map<string, Net> {
    if (this.#nets) return this.#nets;
    const groups = new Map<string, { gpios: GpioDefinition[]; pins: Net['pins'][number][] }>();
    // Insertion order of #endpoints is wire order, so nets come out deterministic.
    for (const [key, endpoint] of this.#endpoints) {
      const root = this.#find(key);
      let group = groups.get(root);
      if (!group) {
        group = { gpios: [], pins: [] };
        groups.set(root, group);
      }
      if (endpoint.type === 'gpio') {
        const gpio = this.gpio(endpoint.gpio);
        if (gpio) group.gpios.push(gpio);
      } else {
        group.pins.push({ part: endpoint.part, pin: endpoint.pin });
      }
    }
    for (const group of groups.values()) group.gpios.sort((x, y) => x.gpio - y.gpio);
    this.#nets = groups;
    return groups;
  }
}
