#!/usr/bin/env node
import { installTerminationHandlers } from '../bridge/process.ts';
import { main } from './cli.ts';

// This process owns itself: a signal must not leave a firmware behind.
installTerminationHandlers();

process.exitCode = await main(process.argv.slice(2));
