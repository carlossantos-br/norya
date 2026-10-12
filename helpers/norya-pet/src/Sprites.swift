import AppKit
import ImageIO

// MARK: - Manifesto (assets/pet/manifest.json, gerado por tools/pet-assets.py)

struct StateDef: Decodable {
    let file: String
    let frames: Int
    let durations: [Double]        // ms por quadro
    let filter: String             // nearest | linear
    let mirror: Bool
    let loops: Int
    let introFrames: Int?
    let loopStart: Int?
    let loopFrames: Int?
    let after: String?             // "hold" = fica no último quadro; default = cai no idle lento
    let idleSlow: Double?          // idle: multiplicador das durações (Codex = 6)
    let idlePauseMs: Double?       // idle: pausa no quadro 0 entre repetições (Clawd = 5000)
}

struct CellDef: Decodable { let w: Double; let h: Double }

struct PetDef: Decodable {
    let name: String
    let cell: CellDef
    let filter: String
    let sizing: String             // fitWidth | pixelSnap
    let states: [String: StateDef]
}

struct Manifest: Decodable { let pets: [String: PetDef] }

func loadManifest(_ dir: String) -> Manifest? {
    let url = URL(fileURLWithPath: dir).appendingPathComponent("manifest.json")
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(Manifest.self, from: data)
}

// MARK: - Cache de tiras (≤ 3 estados decodificados; o resto é descartado)

final class StripCache {
    private let dir: String
    private var order: [String] = []
    private var store: [String: [CGImage]] = [:]
    static let limit = 3

    init(dir: String) { self.dir = dir }

    func frames(_ file: String, count n: Int) -> [CGImage] {
        if let f = store[file] {
            order.removeAll { $0 == file }; order.append(file)
            return f
        }
        let url = URL(fileURLWithPath: dir).appendingPathComponent(file)
        guard n > 0, let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return [] }
        let w = img.width / n
        let out = (0..<n).compactMap { img.cropping(to: CGRect(x: $0 * w, y: 0, width: w, height: img.height)) }
        store[file] = out
        order.append(file)
        while order.count > StripCache.limit {
            store[order.removeFirst()] = nil
        }
        return out
    }

    func clear() { store.removeAll(); order.removeAll() }
}

// MARK: - Player: UM timer, dorme até o próximo quadro

final class Player {
    let layer = CALayer()
    var reduceMotion = false

    private let cache: StripCache
    private var def: PetDef?
    private var frames: [CGImage] = []
    private var steps: [(frame: Int, dur: Double)] = []
    private var idx = 0
    private var looping = false
    private var hold = false
    private let timer: DispatchSourceTimer

    init(cache: StripCache) {
        self.cache = cache
        layer.contentsGravity = .resize
        layer.actions = ["contents": NSNull(), "transform": NSNull(), "bounds": NSNull(), "position": NSNull()]
        timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .distantFuture, repeating: .never)
        timer.setEventHandler { [weak self] in self?.advance() }
        timer.resume()
    }

    func setPet(_ d: PetDef?) {
        def = d
        stop()
        frames = []; steps = []
        layer.contents = nil
    }

    func play(_ name: String) {
        guard let d = def, let sd = d.states[name] ?? d.states["idle"] else { return }
        start(sd, idle: name == "idle" || d.states[name] == nil)
    }

    private func start(_ sd: StateDef, idle: Bool) {
        frames = cache.frames(sd.file, count: sd.frames)
        guard !frames.isEmpty else { return }
        let n = min(frames.count, sd.durations.count)
        let sec = { (i: Int) -> Double in sd.durations[i] / 1000.0 }
        steps = []
        if idle {
            let slow = sd.idleSlow ?? 1
            steps = (0..<n).map { ($0, sec($0) * slow) }
            if let p = sd.idlePauseMs { steps.append((0, p / 1000.0)) }
            looping = true; hold = false
        } else {
            if let intro = sd.introFrames, let ls = sd.loopStart, let lf = sd.loopFrames, ls >= 0, ls < n {
                steps += (0..<max(0, min(intro, n))).map { ($0, sec($0)) }
                for _ in 0..<max(1, sd.loops) { steps += (ls..<max(ls, min(ls + lf, n))).map { ($0, sec($0)) } }
            } else {
                for _ in 0..<max(1, sd.loops) { steps += (0..<n).map { ($0, sec($0)) } }
            }
            looping = false
            hold = sd.after == "hold"
        }
        guard !steps.isEmpty else { return }   // manifesto sem durações: nada a tocar (nunca índice fora)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let f: CALayerContentsFilter = sd.filter == "nearest" ? .nearest : .linear
        layer.magnificationFilter = f
        layer.minificationFilter = f
        layer.setAffineTransform(sd.mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity)
        idx = 0
        layer.contents = frames[steps[0].frame]
        CATransaction.commit()
        if reduceMotion { stop(); return }   // quadro 0 estático, timer parado
        arm(steps[0].dur)
    }

    private func arm(_ s: Double) {
        timer.schedule(deadline: .now() + s, repeating: .never, leeway: .milliseconds(25))
    }

    func stop() { timer.schedule(deadline: .distantFuture, repeating: .never) }

    /// Janela escondida: para o timer e solta tudo o que foi decodificado.
    func release() {
        stop()
        cache.clear()
        frames = []; steps = []
        layer.contents = nil
    }

    private func advance() {
        guard !steps.isEmpty else { return }
        idx += 1
        if idx >= steps.count {
            if looping { idx = 0 }
            else if hold { idx = steps.count - 1; stop(); return }
            else { play("idle"); return }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.contents = frames[steps[idx].frame]
        CATransaction.commit()
        arm(steps[idx].dur)
    }
}
