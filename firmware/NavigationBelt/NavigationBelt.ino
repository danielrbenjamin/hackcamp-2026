#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEService.h>
#include <BLECharacteristic.h>

// Motor driver pins, ordered from far left to far right.
constexpr uint8_t pins[] = {13, 14, 25, 26, 27};
constexpr char serviceUuid[] = "08D24000-8CB7-4DAA-AE03-54C7D9655B00";
constexpr char commandUuid[] = "08D24001-8CB7-4DAA-AE03-54C7D9655B00";
constexpr unsigned long timeoutMs = 600;

struct Cue {
  uint8_t kind;
  uint8_t strength[5];
  unsigned long startedAt;
  unsigned long receivedAt;
};

portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
Cue cue{};
bool advertiseAgain = false;

class LinkCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer*) override {
    portENTER_CRITICAL(&lock);
    cue = {};
    advertiseAgain = true;
    portEXIT_CRITICAL(&lock);
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const auto packet = characteristic->getValue();
    if (packet.length() != 7 || packet[0] != 1 || static_cast<uint8_t>(packet[1]) > 2) return;
    const auto now = millis();
    const auto kind = static_cast<uint8_t>(packet[1]);
    portENTER_CRITICAL(&lock);
    if (cue.kind != kind || now - cue.receivedAt >= timeoutMs) cue.startedAt = now;
    cue.kind = kind;
    cue.receivedAt = now;
    for (size_t i = 0; i < 5; ++i) cue.strength[i] = static_cast<uint8_t>(packet[i + 2]);
    portEXIT_CRITICAL(&lock);
  }
};

void setup() {
  for (const auto pin : pins) {
    if (!ledcAttach(pin, 2000, 8)) {
      for (const auto motor : pins) { pinMode(motor, OUTPUT); digitalWrite(motor, LOW); }
      return;
    }
    ledcWrite(pin, 0);
  }
  BLEDevice::init("Navigation Belt");
  auto* server = BLEDevice::createServer();
  server->setCallbacks(new LinkCallbacks());
  auto* service = server->createService(serviceUuid);
  auto* characteristic = service->createCharacteristic(commandUuid, BLECharacteristic::PROPERTY_WRITE_NR);
  characteristic->setCallbacks(new CommandCallbacks());
  service->start();
  BLEDevice::getAdvertising()->addServiceUUID(serviceUuid);
  BLEDevice::startAdvertising();
}

void loop() {
  portENTER_CRITICAL(&lock);
  const Cue current = cue;
  const bool restart = advertiseAgain;
  advertiseAgain = false;
  portEXIT_CRITICAL(&lock);
  const auto now = millis();
  const auto age = now - current.startedAt;
  const bool warningPulse = current.kind == 2 && age % 140 < 75;
  const bool directionPulse = current.kind == 1 && age % 800 < 160;
  const bool on = now - current.receivedAt < timeoutMs && (warningPulse || directionPulse);
  for (size_t i = 0; i < 5; ++i) ledcWrite(pins[i], on ? current.strength[i] : 0);
  if (restart) BLEDevice::startAdvertising();
  delay(5);
}
