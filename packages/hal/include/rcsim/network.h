#pragma once
#include <cstdint>

class WiFiServer;
class WiFiUDP;
namespace rcsim::hal {
// Sim host diagnostics only: borrowed descriptors, no clock advance or pumping.
struct NetworkAccess;
int socketFd(const WiFiServer& server);
int socketFd(const WiFiUDP& udp);
uint16_t hostPort(const WiFiServer& server);
}  // namespace rcsim::hal
