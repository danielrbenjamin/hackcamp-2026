#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEService.h>
#include <BLECharacteristic.h>

constexpr uint8_t pins[] = {25, 33, 26}; // Left, front, right.
constexpr uint8_t channels[] = {0, 2, 4};
constexpr size_t buzzerCount = sizeof(pins) / sizeof(pins[0]);
constexpr uint32_t toneHz = 1000;
constexpr uint8_t pwmBits = 10;
// Bench-tune these duty limits for the fitted buzzers. Keep warnings audible.
constexpr uint8_t directionDuty = 8;
constexpr uint8_t warningDuty = 16;
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
bool beltConnected = false;
bool advertiseAgain = false;

class LinkCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    portENTER_CRITICAL(&lock);
    beltConnected = true;
    cue = {};
    portEXIT_CRITICAL(&lock);
    Serial.println("Phone connected.");
  }

  void onDisconnect(BLEServer*) override {
    portENTER_CRITICAL(&lock);
    beltConnected = false;
    cue = {};
    advertiseAgain = true;
    portEXIT_CRITICAL(&lock);
    Serial.println("Phone disconnected + clearing cues");
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
  Serial.begin(115200);
  for (const auto pin : pins) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }
  for (size_t i = 0; i < buzzerCount; ++i) {
    if (!ledcAttachChannel(pins[i], toneHz, pwmBits, channels[i])) {
      for (size_t attached = 0; attached < i; ++attached) {
        ledcWrite(pins[attached], 0);
        ledcDetach(pins[attached]);
      }
      for (const auto pin : pins) {
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
      }
      Serial.println("Buzzer setup failed!! reset");
      while (true) delay(1000);
    }
    ledcWrite(pins[i], 0);
  }
  BLEDevice::init("Navigation Belt");
  auto* server = BLEDevice::createServer();
  server->setCallbacks(new LinkCallbacks());
  auto* service = server->createService(serviceUuid);
  auto* characteristic = service->createCharacteristic(
    commandUuid,
    BLECharacteristic::PROPERTY_WRITE_NR | BLECharacteristic::PROPERTY_WRITE
  );
  characteristic->setCallbacks(new CommandCallbacks());
  service->start();
  BLEDevice::getAdvertising()->addServiceUUID(serviceUuid);
  BLEDevice::getAdvertising()->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("Navigation Belt ready");
  Serial.println("USB buzzer test when disconnected: l = left, f = front, r = right");
}

void testBuzzerFromSerial() {
  const int command = Serial.read();
  const int channel = command == 'l' ? 1 : command == 'f' ? 2 : command == 'r' ? 3 : -1;
  if (channel < 0) return;
  const auto now = millis();
  portENTER_CRITICAL(&lock);
  const bool allowed = !beltConnected;
  if (allowed) {
    cue = {};
    cue.kind = 1;
    cue.strength[channel] = 255;
    cue.startedAt = cue.receivedAt = now;
  }
  portEXIT_CRITICAL(&lock);
  if (allowed) {
    Serial.printf("Testing %s buzzer (GPIO %u)\n",
      command == 'l' ? "left" : command == 'f' ? "front" : "right", unsigned(pins[channel - 1]));
  } else {
    Serial.println("Disconnect Bluetooth before testing buzzers over USB.");
  }
}

void loop() {
  testBuzzerFromSerial();
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
  const auto maxDuty = current.kind == 2 ? warningDuty : directionDuty;
  const uint8_t strengths[buzzerCount] = {
    current.strength[0] > current.strength[1] ? current.strength[0] : current.strength[1],
    current.strength[2],
    current.strength[3] > current.strength[4] ? current.strength[3] : current.strength[4]
  };
  for (size_t i = 0; i < buzzerCount; ++i) {
    const uint32_t duty = on ? (uint32_t(strengths[i]) * maxDuty + 254) / 255 : 0;
    ledcWrite(pins[i], duty);
  }
  if (restart) BLEDevice::startAdvertising();
  delay(5);
}
