import { parseArgs } from 'node:util';
import { parseAssertion, type ScenarioSpec } from '../api/scenario.ts';
import { ScenarioInputError, readWorld, runScenario, type ScenarioIo } from './runner.ts';

const USAGE = `usage: rcsim run --car <car.json> --world <world.json> --seconds <n> [options]

  --script <timeline.json>   scripted PWM timeline: [{"tUs":0,"gpio":26,"pulseUs":1500}, ...]
  --seed <n>                 seed for all randomness (default: the world file's)
  --tick-us <n>              tick length in microseconds (default 1000)
  --assert <expr>            assertion, repeatable: "collisions == 0", "laps >= 1",
                             "maxSpeed < 3" (metrics: collisions, laps, maxSpeed, distance,
                             simSeconds; speeds in m/s, distances in metres)

Prints the result as JSON. Exit code 0 when every assertion holds, 1 when one fails
or the run ended abnormally, 2 for bad arguments or input files.`;

export interface CliIo extends ScenarioIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

/** The `rcsim` command. Returns the process exit code. */
export async function main(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => process.stdout.write(text));
  const err = io.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        car: { type: 'string' },
        world: { type: 'string' },
        seconds: { type: 'string' },
        seed: { type: 'string' },
        'tick-us': { type: 'string' },
        script: { type: 'string' },
        firmware: { type: 'string' },
        control: { type: 'string' },
        assert: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help || positionals.length === 0) {
      (values.help ? out : err)(`${USAGE}\n`);
      return values.help ? 0 : 2;
    }
    if (positionals[0] !== 'run' || positionals.length > 1) {
      throw new ScenarioInputError(`unknown command "${positionals.join(' ')}"`);
    }
    const need = (name: 'car' | 'world' | 'seconds'): string => {
      const value = values[name];
      if (value === undefined) throw new ScenarioInputError(`--${name} is required`);
      return value;
    };
    const number = (name: string, text: string, integer = false): number => {
      const value = Number(text);
      if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
        throw new ScenarioInputError(
          `--${name} must be a non-negative ${integer ? 'integer' : 'number'}, got "${text}"`,
        );
      }
      return value;
    };

    const spec: ScenarioSpec = {
      car: need('car'),
      world: need('world'),
      seconds: number('seconds', need('seconds')),
      seed:
        values.seed !== undefined
          ? number('seed', values.seed, true)
          : (await readWorld(need('world'), io)).seed,
      ...(values['tick-us'] !== undefined
        ? { tickUs: number('tick-us', values['tick-us'], true) }
        : {}),
      ...(values.script !== undefined ? { script: values.script } : {}),
      ...(values.firmware !== undefined ? { firmware: values.firmware } : {}),
      ...(values.control !== undefined ? { control: values.control } : {}),
      assertions: (values.assert ?? []).map((text) => {
        try {
          return parseAssertion(text);
        } catch (error) {
          throw new ScenarioInputError((error as Error).message);
        }
      }),
    };
    const result = await runScenario(spec, io);
    out(`${JSON.stringify(result, null, 2)}\n`);
    return result.passed ? 0 : 1;
  } catch (error) {
    if (
      error instanceof ScenarioInputError ||
      (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    ) {
      err(`rcsim: ${(error as Error).message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
}
