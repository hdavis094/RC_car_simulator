#include "rcsim/runtime.h"

void setup();
void loop();
int main() { return rcsim::hal::runFirmware(setup, loop); }
