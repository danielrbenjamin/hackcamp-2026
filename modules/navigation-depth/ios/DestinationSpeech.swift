import AVFoundation
import ExpoModulesCore
import Speech
import UIKit

// All session state is owned by the main queue. Only the audio tap appends buffers.
final class DestinationSpeech {
  private var promise: Promise?
  private var engine: AVAudioEngine?
  private var recognizer: SFSpeechRecognizer?
  private var task: SFSpeechRecognitionTask?
  private var generation = 0
  private var timeout: DispatchWorkItem?
  private var pause: DispatchWorkItem?
  private var transcript = ""
  private var previousAudio: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions, Bool)?

  func listen(_ promise: Promise, ready: @escaping () -> Void) {
    guard self.promise == nil else { promise.reject("ERR_VOICE_BUSY", "Already listening."); return }
    self.promise = promise
    generation += 1
    let id = generation
    SFSpeechRecognizer.requestAuthorization { [weak self] status in
      DispatchQueue.main.async {
        guard let self, self.generation == id else { return }
        guard status == .authorized else { self.fail("Speech recognition permission is off."); return }
        AVAudioApplication.requestRecordPermission { [weak self] allowed in
          DispatchQueue.main.async {
            guard let self, self.generation == id else { return }
            guard allowed else { self.fail("Microphone permission is off."); return }
            self.start(id, ready: ready)
          }
        }
      }
    }
  }

  func cancel() {
    if let promise = finish() { promise.resolve(nil) }
  }

  private func start(_ id: Int, ready: () -> Void) {
    guard let recognizer = SFSpeechRecognizer(), recognizer.supportsOnDeviceRecognition,
          recognizer.isAvailable else { fail("On-device speech recognition is unavailable."); return }
    self.recognizer = recognizer
    let audioSession = AVAudioSession.sharedInstance()
    let engine = AVAudioEngine()
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    request.taskHint = .search
    do {
      previousAudio = (audioSession.category, audioSession.mode, audioSession.categoryOptions,
                       audioSession.allowHapticsAndSystemSoundsDuringRecording)
      try audioSession.setCategory(.record, mode: .measurement)
      try? audioSession.setAllowHapticsAndSystemSoundsDuringRecording(true)
      try audioSession.setActive(true)
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.channelCount > 0, format.sampleRate > 0 else {
        fail("No microphone input is available.")
        return
      }
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
      self.engine = engine
      engine.prepare()
      try engine.start()
    } catch {
      fail("Could not start the microphone.")
      return
    }
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self, self.generation == id else { return }
        if let result {
          let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
          if !text.isEmpty, text != self.transcript {
            self.transcript = text
            self.pause?.cancel()
            let pause = DispatchWorkItem { [weak self] in self?.complete(id) }
            self.pause = pause
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: pause)
          }
          if result.isFinal { self.complete(id) }
        } else if error != nil {
          if self.transcript.isEmpty { self.fail("Could not recognize a destination.") }
          else { self.complete(id) }
        }
      }
    }
    let timeout = DispatchWorkItem { [weak self] in self?.complete(id) }
    self.timeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    ready()
  }

  private func complete(_ id: Int) {
    guard generation == id else { return }
    let text = transcript
    if text.isEmpty { fail("No destination heard. Try again.") }
    else { finish()?.resolve(text) }
  }

  private func fail(_ message: String) {
    finish()?.reject("ERR_VOICE_DESTINATION", message)
  }

  private func finish() -> Promise? {
    guard let promise else { return nil }
    self.promise = nil
    generation += 1
    timeout?.cancel()
    pause?.cancel()
    timeout = nil
    pause = nil
    task?.cancel()
    task = nil
    if let engine {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    if let (category, mode, options, allowedHaptics) = previousAudio {
      let audioSession = AVAudioSession.sharedInstance()
      try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
      try? audioSession.setCategory(category, mode: mode, options: options)
      try? audioSession.setAllowHapticsAndSystemSoundsDuringRecording(allowedHaptics)
    }
    previousAudio = nil
    engine = nil
    recognizer = nil
    transcript = ""
    return promise
  }
}
