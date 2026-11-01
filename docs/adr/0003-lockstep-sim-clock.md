# The sim owns the clock and runs firmware in lockstep

`sim-core` advances time in fixed 1 ms ticks. Inside the firmware, `millis()`, `micros()` and `delay()` read and wait on sim time, and every hal call costs a small fixed amount of virtual time. Letting the firmware run free on the wall clock would be simpler, but a slow frame would change the outcome. Lockstep makes every run deterministic for the same firmware, world and seed. That gives pause, single-step, faster-than-real-time runs, and automated scenario tests that agents and CI can trust.

## Consequences

Live network traffic is the one non-deterministic input, and scenario tests script it instead. Firmware that spins without calling any hal function never yields; the session detects this with a wall-clock stall timeout and reports it as a watchdog trip.
