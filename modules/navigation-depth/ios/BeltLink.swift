import CoreBluetooth
import Foundation

final class BeltLink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private let service = CBUUID(string: "08D24000-8CB7-4DAA-AE03-54C7D9655B00")
  private let command = CBUUID(string: "08D24001-8CB7-4DAA-AE03-54C7D9655B00")
  private let batteryService = CBUUID(string: "180F")
  private let batteryLevel = CBUUID(string: "2A19")
  private var manager: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var writer: CBCharacteristic?
  private var pending: Data?
  private var active = false
  private var battery: Int?
  private var emit: (([String: Any]) -> Void)?

  func start(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    guard !active else { report(); return }
    active = true
    if manager == nil { manager = CBCentralManager(delegate: self, queue: .main) }
    else { scan() }
  }

  func stop() {
    if writer != nil { send(cue: "idle", strengths: [0, 0, 0, 0, 0]) }
    active = false
    manager?.stopScan()
    if let peripheral { manager?.cancelPeripheralConnection(peripheral) }
    reset()
  }

  func send(cue: String, strengths: [Double]) {
    guard writer != nil, strengths.count == 5, strengths.allSatisfy({ $0.isFinite }) else { return }
    let kind: UInt8 = cue == "obstacle" ? 2 : cue == "direction" ? 1 : 0
    pending = Data([1, kind] + strengths.map { UInt8((min(1, max(0, $0)) * 255).rounded()) })
    flush()
  }

  private func flush() {
    guard let peripheral, let writer, let pending, peripheral.canSendWriteWithoutResponse else { return }
    peripheral.writeValue(pending, for: writer, type: .withoutResponse)
    self.pending = nil
  }

  private func report() {
    emit?(["source": "ble", "connected": writer != nil, "battery": battery.map { $0 as Any } ?? NSNull(),
           "state": writer != nil ? "connected" : manager?.state == .poweredOn && active ? "scanning" : "unavailable"])
  }

  private func reset() {
    peripheral = nil
    writer = nil
    pending = nil
    battery = nil
    report()
  }

  private func scan() {
    report()
    guard active, let manager, manager.state == .poweredOn, peripheral == nil else { return }
    manager.scanForPeripherals(withServices: [service])
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    if central.state != .poweredOn { reset() }
    scan()
  }

  func centralManager(_ central: CBCentralManager, didDiscover device: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard active, peripheral == nil else { return }
    central.stopScan()
    peripheral = device
    central.connect(device)
  }

  func centralManager(_ central: CBCentralManager, didConnect device: CBPeripheral) {
    guard active, peripheral === device else { central.cancelPeripheralConnection(device); return }
    device.delegate = self
    device.discoverServices([service, batteryService])
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral device: CBPeripheral, error: Error?) {
    if peripheral === device { reset(); scan() }
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect device: CBPeripheral, error: Error?) {
    if peripheral === device { reset(); scan() }
  }

  func peripheral(_ device: CBPeripheral, didDiscoverServices error: Error?) {
    guard active, peripheral === device else { return }
    guard let control = device.services?.first(where: { $0.uuid == service }), error == nil else {
      manager?.cancelPeripheralConnection(device)
      return
    }
    device.discoverCharacteristics([command], for: control)
    if let battery = device.services?.first(where: { $0.uuid == batteryService }) {
      device.discoverCharacteristics([batteryLevel], for: battery)
    }
  }

  func peripheral(_ device: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard active, peripheral === device else { return }
    if service.uuid == self.service {
      guard let characteristic = service.characteristics?.first(where: {
        $0.uuid == command && $0.properties.contains(.writeWithoutResponse)
      }), error == nil else { manager?.cancelPeripheralConnection(device); return }
      writer = characteristic
      report()
    } else if let characteristic = service.characteristics?.first(where: { $0.uuid == batteryLevel }) {
      if characteristic.properties.contains(.read) { device.readValue(for: characteristic) }
      if characteristic.properties.contains(.notify) { device.setNotifyValue(true, for: characteristic) }
    }
  }

  func peripheral(_ device: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard active, peripheral === device, characteristic.uuid == batteryLevel,
          error == nil, let value = characteristic.value?.first, value <= 100 else { return }
    battery = Int(value)
    report()
  }

  func peripheralIsReady(toSendWriteWithoutResponse device: CBPeripheral) {
    if peripheral === device { flush() }
  }
}
