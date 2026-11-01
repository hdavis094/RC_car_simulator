# Donkey Car Simulator

A desktop tool for designing an ESP32 RC car and testing its firmware in a deterministic simulation before it runs on hardware.

## The car

**Car project**:
A folder holding one car's design, firmware and saved worlds; it also builds for the real board.
_Avoid_: workspace, save, sketch folder

**Part**:
One physical component placed on the car, such as a servo, a sensor or the controller.
_Avoid_: component, module, device (except inside firmware APIs)

**Part definition**:
The data file describing a kind of part: its metadata, electrical values, pins and behavior template.
_Avoid_: part spec, part type

**Catalog**:
The set of part definitions available to a car project: the built-in ones plus the project's custom parts.
_Avoid_: library, inventory

**Custom part**:
A part definition created by the user and stored in the car project.

**Behavior template**:
A built-in, parameterised model of how a kind of part behaves in the sim, such as `distance-raycast`, `imu`, `servo` or `esc-motor`.
_Avoid_: driver, plugin

**Controller**:
The board that runs the firmware; in v1 always an ESP32.
_Avoid_: MCU, brain, microcontroller

**Chassis**:
The part that carries everything else and decides the car's geometry and mount points.

**Mount point**:
A named attachment position on the chassis (front-left, front-centre, front-right, roof, rear) that a part is placed on.

**Placement**:
A part's mount point plus its fine-tuned offset and angle.
_Avoid_: position, pose (pose is the car's position in the world)

**Pin assignment**:
The mapping of a part's pins to controller GPIOs.
_Avoid_: wiring (wiring rules check pin assignments)

**Wiring rule**:
An electrical check over the pin assignments, such as a pin conflict, an input-only pin used as output, or a level mismatch.
_Avoid_: validation, lint

**Car config header**:
The generated `car_config.h` that tells the firmware the pin assignments and I²C addresses.

**Firmware**:
The Arduino C++ program that runs on the controller and drives the car.
_Avoid_: sketch, code, program

**Starter firmware**:
The firmware every new car project begins with: control protocol, obstacle avoidance and failsafe.
_Avoid_: template, example

## Driving

**Manual mode**:
The firmware follows `drive` commands from a person.

**Auto mode**:
The firmware drives itself from its sensors.

**Failsafe**:
The firmware stopping the car when manual commands stop arriving for 500 ms.

**E-stop**:
A command that stops the car immediately in any mode.

**Control protocol**:
The JSON-lines protocol over TCP between a laptop and the car, the same on the real car and in the sim.
_Avoid_: car API, remote protocol

## Simulation

**Run**:
One execution of a car project's firmware in a world, from Run in Sim until stop.
_Avoid_: session, game, play

**Sim time**:
The clock the simulation owns. It is the only time the firmware sees.
_Avoid_: game time

**Tick**:
One fixed step of sim time, 1 ms by default.
_Avoid_: frame (a frame is a render)

**Lockstep**:
The firmware and the sim advancing together tick by tick, so a run is deterministic.

**Seed**:
The number that fixes all sensor noise and other randomness in a run.

**World**:
A track plus a layout of obstacles and a start position.
_Avoid_: scene, level, map

**Track**:
A fixed course the car drives on; v1 has an oval and a technical circuit.
_Avoid_: circuit (except as a track's name)

**Obstacle**:
An object placed in a world for the car to avoid: cone, box, wall section or ramp.

**Reading**:
A measurement a sensor part produces at its update rate, such as a distance or an acceleration.
_Avoid_: sample, value

**Scenario**:
A headless run with fixed firmware, world, seed and duration, plus assertions about what must happen.
_Avoid_: test case (a scenario is one kind of test)

**v1 scenario**:
The scenario that defines v1: starter firmware, the oval with a fixed cone layout, 60 s, no collisions and at least one lap.

## Environments

**Workbench**:
Where the user chooses parts, assigns pins and places sensors.

**Terminal**:
Where the user edits, builds and runs firmware, with a serial monitor and a shell.

**3D World**:
Where a run plays out and the user edits obstacles and drives.
_Avoid_: viewer, simulator window

**Serial Monitor**:
A live view of the firmware's serial output, with a line for sending input.

**Network Console**:
A raw control-protocol connection to the car, for typing commands and watching telemetry.

## Building this project

**Contract**:
A shared interface that several tasks depend on. Written in Phase 0, then changed only by the orchestrator.

**Task brief**:
A file in `docs/tasks/` describing one unit of work: goal, owned paths, acceptance criteria.
_Avoid_: ticket, issue, story

**Owned paths**:
The paths a task brief allows its worker to write.

**Handoff**:
The section a worker fills in at the end of its task brief: what was built, deviations, contract change requests.

**Orchestrator**:
The agent that dispatches task briefs, reviews and merges branches.

**Worker**:
An agent carrying out one task brief in its own worktree.
