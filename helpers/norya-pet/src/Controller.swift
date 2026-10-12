import AppKit

final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { true }      // barra de chat / resposta inline recebem teclado
    override var canBecomeMain: Bool { false }
    // Janela justa ao conteúdo pode passar da borda da tela (X da pílula, badge).
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class RootView: NSView {
    // Área vazia não é de ninguém (o alpha 0 do layer deixa o clique atravessar).
    override func hitTest(_ p: NSPoint) -> NSView? {
        let v = super.hitTest(p)
        return v === self ? nil : v
    }
}

struct Config {
    var kind = "auto"
    var size: CGFloat = 112
    var visibility = "always"
    var badgeCorner = "top-end"
    var pillsVisible = true
}

final class Controller: NSObject, PillActions, NSTextFieldDelegate {
    static let margin: CGFloat = 24
    static let barGap: CGFloat = 6
    static let trayGap: CGFloat = 8
    static let pad: CGFloat = 8

    let manifest: Manifest?
    let player: Player
    let panel: PetPanel
    let root = RootView()
    let tray = TrayView()
    let bar = ChatBar()
    let mascot = MascotView()
    let badge = BadgeView()
    let chevron = IconButton(symbol: "chevron.down", size: 10, label: "Ocultar atividade")

    var cfg = Config()
    var positions: [String: NSPoint] = [:]
    var greeted: Set<String> = []
    var statePet: String?
    var stateSprite = "idle"
    var statePills: [Pill] = []
    var dismissed: Set<String> = []
    var expanded = false

    var mascotOrigin: NSPoint?
    var lastMascotSize: NSSize = .zero
    var visible = false
    var hovering = false
    var dragDir: String?
    var playing = ""
    var shownPet: String?
    var greeting: Pill?
    var greetWork: DispatchWorkItem?
    var chatFocused = false
    var trayTop = true
    var monitor: Any?

    // arrasto
    var dragStartScreen = NSPoint.zero
    var dragPanelOrigin = NSPoint.zero
    var dragMascotOrigin = NSPoint.zero
    var dragAnchorX: CGFloat = 0

    init(manifest: Manifest?, assets: String) {
        self.manifest = manifest
        player = Player(cache: StripCache(dir: assets))
        panel = PetPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        super.init()
        player.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.canHide = false                      // independente do ⌘H
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.animationBehavior = .none
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = root
        root.wantsLayer = true

        mascot.wantsLayer = true
        mascot.layer?.addSublayer(player.layer)
        mascot.addSubview(chevron)
        chevron.isHidden = true
        for v in [tray, bar, mascot, badge] as [NSView] { root.addSubview(v) }
        badge.isHidden = true
        tray.actions = self
        bar.field.delegate = self
        bar.field.onBecome = { [weak self] in if self?.panel.isKeyWindow == true { self?.setChatFocused(true) } }

        mascot.onHover = { [weak self] h in self?.setHover(h) }
        mascot.onClick = { emit(["ev": "openApp"]) }
        mascot.onMenu = { [weak self] e in self?.mascotMenu(e, in: self?.mascot) }
        mascot.onDragStart = { [weak self] e in self?.dragStart(e) }
        mascot.onDrag = { [weak self] e in self?.dragMove(e) }
        mascot.onDragEnd = { [weak self] e in self?.dragEnd(e) }
        bar.onDragStart = { [weak self] e in self?.dragStart(e) }
        bar.onDrag = { [weak self] e in self?.dragMove(e) }
        bar.onDragEnd = { [weak self] e in self?.dragEnd(e) }
        bar.onMenu = { [weak self] e in self?.mascotMenu(e, in: self?.bar) }
        chevron.onTap = { [weak self] in self?.chevronTapped() }
        badge.onClick = { [weak self] in
            guard let s = self else { return }
            s.cfg.pillsVisible = true
            emit(["ev": "prefs", "pillsVisible": true]); s.relayout()
        }
        badge.onDropped = { [weak self] c in self?.badgeDropped(c) }

        let nc = NotificationCenter.default
        nc.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
            self?.tray.cancelReplies()
            if self?.chatFocused == true { self?.setChatFocused(false) }
        }
        nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.screensChanged()
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            guard let s = self else { return }
            s.player.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            if s.visible { s.applySprite(force: true) }
        }
    }

    // MARK: - derived

    var activePet: String? {
        guard let m = manifest else { return nil }
        let id: String
        switch cfg.kind {
        case "none": return nil
        case "codex", "clawd": id = cfg.kind
        default: id = statePet ?? "codex"
        }
        return m.pets[id] != nil ? id : nil
    }
    var hasMascot: Bool { activePet != nil }
    var backing: CGFloat { panel.screen?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2 }

    func mascotSize() -> NSSize {
        guard let id = activePet, let d = manifest?.pets[id] else { return NSSize(width: cfg.size, height: 0) }
        if d.sizing == "pixelSnap" {
            let px = max(1, (cfg.size * backing / CGFloat(d.cell.w)).rounded())
            return NSSize(width: CGFloat(d.cell.w) * px / backing, height: CGFloat(d.cell.h) * px / backing)
        }
        return NSSize(width: cfg.size, height: ceil(cfg.size * CGFloat(d.cell.h / d.cell.w)))
    }

    var realPills: [Pill] { statePills.filter { !dismissed.contains($0.id) } }
    var trayPills: [Pill] {
        let g = greeting.map { [$0] } ?? []
        if cfg.pillsVisible || !hasMascot { return g + realPills }
        return g
    }

    func effectiveSprite() -> String {
        dragDir ?? (hovering ? "jumping" : (greeting != nil ? "waving" : stateSprite))
    }

    func applySprite(force: Bool = false) {
        guard visible, hasMascot else { return }
        let s = effectiveSprite()
        if s != playing || force { playing = s; player.play(s) }
    }

    func applyPet() {
        let id = activePet
        guard id != shownPet else { return }
        shownPet = id
        playing = ""
        if let id = id, let d = manifest?.pets[id] { player.setPet(d); mascot.isHidden = false }
        else { player.setPet(nil); mascot.isHidden = true }
    }

    // MARK: - mensagens

    func handle(_ m: [String: Any]) {
        switch m["op"] as? String {
        case "config": applyConfig(m)
        case "state": applyState(m)
        case "show": show()
        case "hide": hide()
        case "focusChat": focusChat()
        case "blurChat": blurChat()
        case "pillError":
            if let id = m["id"] as? String {
                let t = (m["text"] as? String) ?? ""
                tray.card(id)?.flash(t.isEmpty ? "Não foi possível enviar a resposta" : t, error: true, seconds: 5)
            }
        default: break
        }
    }

    func applyConfig(_ m: [String: Any]) {
        if let v = m["petKind"] as? String { cfg.kind = v }
        if let v = (m["size"] as? NSNumber)?.doubleValue { cfg.size = CGFloat(min(224, max(80, v))) }
        if let v = m["visibility"] as? String { cfg.visibility = v }
        if let v = m["badgeCorner"] as? String { cfg.badgeCorner = v }
        if let v = m["pillsVisible"] as? Bool { cfg.pillsVisible = v }
        if let v = m["greeted"] as? [String] { greeted.formUnion(v) }
        if let p = m["positions"] as? [String: Any] {
            positions = [:]
            for (k, v) in p {
                if let d = v as? [String: Any], let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue {
                    positions[k] = NSPoint(x: x, y: y)
                }
            }
        }
        if visible {
            applyPet(); relayout(); applySprite(); updateMonitor(); maybeGreet()
        }
    }

    func applyState(_ m: [String: Any]) {
        if let p = m["pet"] as? String { statePet = p }
        stateSprite = (m["sprite"] as? String) ?? "idle"
        let known: Set<String> = ["running", "waiting", "failed", "review", "info", "starting", "error"]
        var out: [Pill] = []
        for raw in (m["pills"] as? [[String: Any]]) ?? [] {
            guard let idv = raw["id"] else { continue }
            let id = (idv as? String) ?? "\(idv)"
            let st = (raw["status"] as? String) ?? "info"
            out.append(Pill(id: id, status: known.contains(st) ? st : "info",
                            title: (raw["title"] as? String) ?? "", subtitle: (raw["subtitle"] as? String) ?? "",
                            canReply: (raw["canReply"] as? Bool) ?? false, canStop: (raw["canStop"] as? Bool) ?? false))
        }
        statePills = out
        let ids = Set(out.map { $0.id })
        dismissed = dismissed.filter { ids.contains($0) }
        if out.count <= 1 { expanded = false }
        if visible { applyPet(); relayout(); applySprite(); maybeGreet() }
    }

    // MARK: - visibilidade

    func show() {
        if visible && panel.isVisible { return }
        visible = true
        applyPet()
        // Tela sumiu enquanto escondido (screensChanged só age com o Mini visível).
        if let o = mascotOrigin {
            let sz = mascotSize()
            let c = NSPoint(x: o.x + sz.width / 2, y: o.y + sz.height / 2)
            if !NSScreen.screens.contains(where: { $0.frame.contains(c) }) { mascotOrigin = nil }
        }
        if mascotOrigin == nil { mascotOrigin = initialOrigin() }
        lastMascotSize = mascotSize()
        relayout()
        applySprite(force: true)
        if !panel.isVisible {
            panel.alphaValue = player.reduceMotion ? 1 : 0
            panel.orderFrontRegardless()
            panel.makeFirstResponder(nil)
            if !player.reduceMotion {
                NSAnimationContext.runAnimationGroup { c in c.duration = 0.3; panel.animator().alphaValue = 1 }
            }
        } else {
            // show no meio do fade-out do hide (120 ms): sem isto o fade terminava em 0
            // e o Mini ficava "visível" mas transparente.
            NSAnimationContext.runAnimationGroup { c in c.duration = player.reduceMotion ? 0 : 0.12; panel.animator().alphaValue = 1 }
        }
        updateMonitor()
        maybeGreet()
    }

    func hide() {
        guard visible else { return }
        visible = false
        if chatFocused || panel.isKeyWindow { blurChat() }
        tray.cancelReplies()
        greetWork?.cancel(); greeting = nil
        removeMonitor()
        player.stop()
        let finish = { [weak self] in
            guard let s = self, !s.visible else { return }
            s.panel.orderOut(nil)
            s.player.release()        // solta quadros decodificados e o timer
            s.playing = ""
        }
        if player.reduceMotion { panel.alphaValue = 0; finish() }
        else {
            NSAnimationContext.runAnimationGroup({ c in c.duration = 0.12; self.panel.animator().alphaValue = 0 },
                                                 completionHandler: finish)
        }
    }

    // Modo "Sob demanda": o monitor global só existe enquanto o Mini está visível.
    func updateMonitor() {
        if visible && cfg.visibility == "onDemand" {
            if monitor == nil {
                monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
                    self?.hideOnDemand()
                }
            }
        } else { removeMonitor() }
    }
    func removeMonitor() {
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
    }
    func hideOnDemand() {
        hide()
        emit(["ev": "hidden"])
    }

    // MARK: - saudação

    func maybeGreet() {
        // Só com a bandeja vazia: no meio do trabalho a saudação tomaria o topo
        // da pilha e o aceno esconderia "Requer input". Tenta de novo no próximo state.
        guard visible, greeting == nil, realPills.isEmpty, let id = activePet, !greeted.contains(id),
              let name = manifest?.pets[id]?.name else { return }
        greeted.insert(id)
        emit(["ev": "prefs", "greeted": Array(greeted).sorted()])
        greeting = Pill(id: "__greet", status: "info", title: "Oi, eu sou \(name)",
                        subtitle: "Estou aqui para ajudar a manter suas sessões fluindo",
                        canReply: false, canStop: false, local: true)
        let w = DispatchWorkItem { [weak self] in self?.endGreeting() }
        greetWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: w)
        relayout(); applySprite()
    }
    func endGreeting() {
        greetWork?.cancel(); greetWork = nil
        guard greeting != nil else { return }
        greeting = nil
        if visible { relayout(); applySprite() }
    }

    // MARK: - hover / chevron / badge

    func setHover(_ h: Bool) {
        hovering = h
        updateChevron()
        applySprite()
    }
    func updateChevron() {
        chevron.isHidden = !(hovering && hasMascot && cfg.pillsVisible && !trayPills.isEmpty)
    }
    func chevronTapped() {
        if expanded && trayPills.count > 1 { expanded = false }
        else { cfg.pillsVisible = false; emit(["ev": "prefs", "pillsVisible": false]) }
        relayout()
    }
    func badgeDropped(_ c: NSPoint) {
        let corners = ["top-start", "top-end", "bottom-start", "bottom-end"]
        let f = mascot.frame
        var best = cfg.badgeCorner, bd = CGFloat.infinity
        for k in corners {
            let p = NSPoint(x: k.hasSuffix("end") ? f.maxX : f.minX, y: k.hasPrefix("top") ? f.maxY : f.minY)
            let d = hypot(p.x - c.x, p.y - c.y)
            if d < bd { bd = d; best = k }
        }
        cfg.badgeCorner = best
        emit(["ev": "prefs", "badgeCorner": best])
        relayout()
    }

    // MARK: - PillActions

    func pillOpen(_ id: String) {
        if id == "__greet" { endGreeting(); return }
        emit(["ev": "openPill", "id": id])
    }
    func pillDismiss(_ id: String) {
        if id == "__greet" { endGreeting(); return }
        dismissed.insert(id)
        emit(["ev": "dismissPill", "id": id])
        if realPills.count <= 1 { expanded = false }
        relayout()
    }
    func pillMute(_ id: String) {
        dismissed.insert(id)
        emit(["ev": "mutePill", "id": id])
        if realPills.count <= 1 { expanded = false }
        relayout()
    }
    func pillReply(_ id: String, _ text: String) { emit(["ev": "reply", "id": id, "text": text]) }
    func pillStop(_ id: String) { emit(["ev": "stop", "id": id]) }
    func pillExpand() { expanded = true; relayout() }

    // MARK: - chat

    func focusChat() {
        guard visible else { return }
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(bar.field)
    }
    func blurChat() {
        panel.makeFirstResponder(nil)
        panel.resignKey()
        setChatFocused(false)
    }
    func setChatFocused(_ f: Bool) {
        guard f != chatFocused else { return }
        chatFocused = f
        emit(["ev": "chatFocus", "focused": f])
        if visible { relayout(animateBar: true) }
    }
    func controlTextDidChange(_ n: Notification) { if visible { relayout(animateBar: true) } }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) {
            let t = bar.field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty {
                emit(["ev": "newChat", "text": t])
                bar.field.stringValue = ""
                blurChat()
            }
            return true
        }
        if sel == #selector(NSResponder.cancelOperation(_:)) { blurChat(); return true }
        return false
    }

    // MARK: - menu

    func mascotMenu(_ e: NSEvent, in view: NSView?) {
        guard let v = view else { return }
        let onDemand = cfg.visibility == "onDemand"
        popMenu([(onDemand ? "Ocultar Mini" : "Fechar Mini", { [weak self] in
                    if onDemand { self?.hideOnDemand() } else { emit(["ev": "close"]) } }),
                 ("Configurações", { emit(["ev": "settings"]) })],
                at: v.convert(e.locationInWindow, from: nil), in: v)
    }

    // MARK: - telas e posição

    func displayId(_ s: NSScreen) -> Int {
        (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
    }
    func screenFor(_ p: NSPoint) -> NSScreen? {
        if let s = NSScreen.screens.first(where: { $0.frame.contains(p) }) { return s }
        return NSScreen.screens.min { a, b in dist(p, a.frame) < dist(p, b.frame) } ?? NSScreen.main
    }
    func dist(_ p: NSPoint, _ r: NSRect) -> CGFloat {
        hypot(max(r.minX - p.x, 0, p.x - r.maxX), max(r.minY - p.y, 0, p.y - r.maxY))
    }
    var barSpace: CGFloat { ChatBar.height + (hasMascot ? Controller.barGap : 0) }

    func defaultOrigin(on s: NSScreen, _ size: NSSize) -> NSPoint {
        let vf = s.visibleFrame
        return NSPoint(x: vf.maxX - Controller.margin - size.width, y: vf.minY + Controller.margin + barSpace)
    }
    func saved(for s: NSScreen, _ size: NSSize) -> NSPoint? {
        let keys = ["\(displayId(s))", "\(Int(s.frame.width))x\(Int(s.frame.height))"]
        for k in keys {
            if let p = positions[k], s.visibleFrame.insetBy(dx: -2, dy: -2).contains(NSPoint(x: p.x + size.width / 2, y: p.y + size.height / 2)) {
                return p
            }
        }
        return nil
    }
    func initialOrigin() -> NSPoint {
        let size = mascotSize()
        let cur = screenFor(NSEvent.mouseLocation) ?? NSScreen.screens.first
        if let c = cur, let p = saved(for: c, size) { return p }
        for s in NSScreen.screens { if let p = saved(for: s, size) { return p } }
        if let c = cur { return defaultOrigin(on: c, size) }
        return NSPoint(x: 100, y: 100)
    }
    func screensChanged() {
        guard visible, let o = mascotOrigin else { return }
        let size = mascotSize()
        let c = NSPoint(x: o.x + size.width / 2, y: o.y + size.height / 2)
        if !NSScreen.screens.contains(where: { $0.frame.contains(c) }) { mascotOrigin = initialOrigin() }
        else { clampMascot() }
        relayout()
    }
    func clampMascot() {
        guard var o = mascotOrigin else { return }
        let size = mascotSize()
        guard let s = screenFor(NSPoint(x: o.x + size.width / 2, y: o.y + size.height / 2)) else { return }
        let vf = s.visibleFrame
        o.x = min(max(o.x, vf.minX), max(vf.minX, vf.maxX - size.width))
        o.y = min(max(o.y, vf.minY + barSpace), max(vf.minY + barSpace, vf.maxY - size.height))
        mascotOrigin = o
    }
    func emitMoved() {
        guard let o = mascotOrigin else { return }
        let size = mascotSize()
        guard let s = screenFor(NSPoint(x: o.x + size.width / 2, y: o.y + size.height / 2)) else { return }
        let id = displayId(s)
        positions["\(id)"] = o
        emit(["ev": "moved", "displayId": id, "w": Int(s.frame.width), "h": Int(s.frame.height),
              "x": Double(o.x), "y": Double(o.y)])
    }

    // MARK: arrasto

    func screenPoint(_ e: NSEvent) -> NSPoint { panel.convertPoint(toScreen: e.locationInWindow) }

    func dragStart(_ e: NSEvent) {
        dragStartScreen = screenPoint(e)
        dragPanelOrigin = panel.frame.origin
        dragMascotOrigin = mascotOrigin ?? .zero
        dragAnchorX = dragStartScreen.x
    }
    func dragMove(_ e: NSEvent) {
        let p = screenPoint(e)
        let dx = p.x - dragStartScreen.x, dy = p.y - dragStartScreen.y
        panel.setFrameOrigin(NSPoint(x: dragPanelOrigin.x + dx, y: dragPanelOrigin.y + dy))
        mascotOrigin = NSPoint(x: dragMascotOrigin.x + dx, y: dragMascotOrigin.y + dy)
        if abs(p.x - dragAnchorX) >= 4 {
            let dir = p.x > dragAnchorX ? "running-right" : "running-left"
            dragAnchorX = p.x
            if dir != dragDir { dragDir = dir; applySprite() }
        }
    }
    func dragEnd(_ e: NSEvent) {
        dragDir = nil
        guard let o = mascotOrigin, o != dragMascotOrigin else { applySprite(); return }
        if e.modifierFlags.contains(.option) { snap() }
        else { clampMascot(); relayout(); emitMoved() }
        applySprite()
    }
    func snap() {
        guard let o = mascotOrigin else { return }
        let size = mascotSize()
        let c = NSPoint(x: o.x + size.width / 2, y: o.y + size.height / 2)
        guard let s = screenFor(c) else { return }
        let vf = s.visibleFrame, m: CGFloat = 16, third = vf.width / 3
        let col = c.x < vf.minX + third ? 0 : (c.x < vf.minX + 2 * third ? 1 : 2)
        let top = c.y > vf.midY
        let tx = col == 0 ? vf.minX + m : (col == 1 ? vf.midX - size.width / 2 : vf.maxX - m - size.width)
        let ty = top ? vf.maxY - m - size.height : vf.minY + m + barSpace
        let dx = tx - o.x, dy = ty - o.y
        let po = panel.frame.origin
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = player.reduceMotion ? 0 : 0.25
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().setFrameOrigin(NSPoint(x: po.x + dx, y: po.y + dy))
        }, completionHandler: { [weak self] in
            guard let s = self else { return }
            s.mascotOrigin = NSPoint(x: tx, y: ty)
            s.relayout(); s.emitMoved()
        })
    }

    // MARK: - layout

    func relayout(animateBar: Bool = false) {
        guard visible, var origin = mascotOrigin else { return }
        let msize = mascotSize()
        if lastMascotSize.width > 0, lastMascotSize != msize {
            origin.x += (lastMascotSize.width - msize.width) / 2     // mantém o centro do pé
            mascotOrigin = origin
        }
        lastMascotSize = msize
        let M = NSRect(origin: origin, size: msize)
        let vf = (screenFor(NSPoint(x: M.midX, y: M.midY)) ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        // barra de chat
        let pillsAny = !realPills.isEmpty
        let wide = chatFocused || !bar.field.stringValue.isEmpty
        let chatW: CGFloat = wide ? 344 : (pillsAny ? 160 : 85)
        bar.setPlaceholder(pillsAny ? "Iniciar novo chat" : "Perguntar")
        var bx = M.midX - chatW / 2
        bx = min(max(bx, vf.minX + 4), max(vf.minX + 4, vf.maxX - 4 - chatW))
        let B = NSRect(x: bx, y: M.minY - (hasMascot ? Controller.barGap : 0) - ChatBar.height, width: chatW, height: ChatBar.height)

        // bandeja
        let pills = trayPills
        var T: NSRect?
        if !pills.isEmpty {
            let h = TrayView.height(pills, expanded: expanded)
            let W = TrayView.width
            let prefTop = M.midY < vf.midY, prefEnd = M.midX > vf.midX
            func rect(_ top: Bool, _ end: Bool) -> NSRect {
                NSRect(x: end ? M.maxX - W : M.minX,
                       y: top ? M.maxY + Controller.trayGap : B.minY - Controller.trayGap - h, width: W, height: h)
            }
            func over(_ r: NSRect) -> CGFloat {
                max(0, vf.minX - r.minX) + max(0, r.maxX - vf.maxX) + max(0, vf.minY - r.minY) + max(0, r.maxY - vf.maxY)
            }
            var best = (prefTop, prefEnd), bo = over(rect(prefTop, prefEnd))
            if bo > 0 {
                for (t, e) in [(prefTop, !prefEnd), (!prefTop, prefEnd), (!prefTop, !prefEnd)] {
                    let o = over(rect(t, e))
                    if o < bo { bo = o; best = (t, e) }
                }
            }
            trayTop = best.0
            T = rect(best.0, best.1)
        }

        var U = B
        if hasMascot { U = U.union(M.insetBy(dx: -Controller.pad, dy: -Controller.pad)) }
        if let t = T { U = U.union(t.insetBy(dx: -Controller.pad, dy: -Controller.pad)) }
        U = U.integral
        if panel.frame != U { panel.setFrame(U, display: false) }
        let loc = { (r: NSRect) in r.offsetBy(dx: -U.minX, dy: -U.minY) }

        tray.isHidden = T == nil
        if let t = T {
            tray.frame = loc(t)
            tray.update(pills, expanded: expanded, awayUp: trayTop)
        } else { tray.update([], expanded: false, awayUp: true) }

        if animateBar && panel.isVisible && !player.reduceMotion {
            NSAnimationContext.runAnimationGroup { c in c.duration = 0.14; bar.animator().frame = loc(B) }
        } else { bar.frame = loc(B) }

        mascot.frame = loc(M)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        player.layer.contentsScale = backing
        player.layer.frame = mascot.bounds
        CATransaction.commit()

        // chevron (lado da bandeja) e badge
        let expandedList = expanded && pills.count > 1
        chevron.symbolName = trayTop ? "chevron.down" : "chevron.up"
        let cl = expandedList ? "Recolher pilha de atividades" : "Ocultar atividade"
        chevron.setAccessibilityLabel(cl); chevron.toolTip = cl
        chevron.frame = NSRect(x: 2, y: trayTop ? max(2, msize.height - 24) : 2, width: 22, height: 22)
        updateChevron()

        let n = realPills.count
        badge.isHidden = !(hasMascot && !cfg.pillsVisible && n > 0)
        if !badge.isHidden {
            badge.count = n
            badge.color = statusColor(realPills.first?.status ?? "running")
            let c = cfg.badgeCorner
            let mf = mascot.frame
            let cx = c.hasSuffix("end") ? mf.maxX - 6 : mf.minX + 6
            let cy = c.hasPrefix("top") ? mf.maxY - 6 : mf.minY + 6
            let s = BadgeView.size
            badge.frame = NSRect(x: cx - s / 2, y: cy - s / 2, width: s, height: s)
            let lbl = "Mostrar atividade, \(n) \(n == 1 ? "item" : "itens")"
            badge.setAccessibilityLabel(lbl); badge.toolTip = lbl
        }
    }
}
