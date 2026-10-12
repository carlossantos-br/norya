import AppKit

// norya-pet: o Mini do Norya (mascote + pilha de notificações + barra de chat).
// Filho do main por stdio, uma mensagem JSON por linha; protocolo em
// a spec interna do Mini (2026-10-05).
//
// Leveza: AppKit puro (sem WebKit/Chromium), UM timer de animação que dorme até o
// próximo quadro, sprites por estado sob demanda (cache ≤ 3), nenhuma CAAnimation
// contínua, nenhum polling (tracking areas .activeAlways; monitor global de clique só
// no modo "Sob demanda" e só com o Mini visível).

signal(SIGPIPE, SIG_IGN)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // sem Dock/menu; o painel é nonactivating

let assets = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let controller = Controller(manifest: loadManifest(assets), assets: assets)

// stdin: uma mensagem JSON por linha. EOF = o Norya acabou ou nos largou.
// read() bloqueante numa thread própria: o readabilityHandler do FileHandle não
// avisa o EOF de pipe com confiabilidade, e um helper órfão ficaria vivo.
Thread.detachNewThread {
    var pending = Data()
    var buf = [UInt8](repeating: 0, count: 4096)
    while true {
        let n = read(0, &buf, buf.count)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { DispatchQueue.main.async { exit(0) }; return }
        pending.append(buf, count: n)
        while let nl = pending.firstIndex(of: 0x0A) {
            let line = pending.subdata(in: pending.startIndex..<nl)
            pending.removeSubrange(pending.startIndex...nl)
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                DispatchQueue.main.async { controller.handle(obj) }
            }
        }
    }
}

emit(["ev": "ready"])
app.run()
