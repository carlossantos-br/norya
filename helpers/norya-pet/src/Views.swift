import AppKit

// MARK: - Utilidades

func emit(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    data.append(0x0A)
    // write(2) e não FileHandle.write: este levanta exceção ObjC (= crash) com o
    // pipe fechado (Norya morreu antes do EOF do stdin chegar). SIGPIPE já é ignorado.
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard var p = raw.baseAddress else { return }
        var left = raw.count
        while left > 0 {
            let n = write(1, p, left)
            if n > 0 { p += n; left -= n } else if n < 0 && errno == EINTR { continue } else { return }
        }
    }
}

func makeGlass(radius: CGFloat) -> NSVisualEffectView {
    let v = NSVisualEffectView()
    v.material = .hudWindow
    v.blendingMode = .behindWindow
    v.state = .active          // o app nunca fica ativo; sem isso o vidro apagaria
    v.wantsLayer = true
    v.layer?.cornerRadius = radius
    v.layer?.cornerCurve = .continuous
    v.layer?.masksToBounds = true
    v.layer?.borderWidth = 0.5
    v.layer?.borderColor = NSColor(white: 1, alpha: 0.14).cgColor
    return v
}

/// Escurece o vidro: sobre fundo claro o HUD fica cinza e o texto branco perde contraste.
func addTint(_ v: NSView) {
    let t = NSView(frame: v.bounds)
    t.autoresizingMask = [.width, .height]
    t.wantsLayer = true
    t.layer?.backgroundColor = NSColor(white: 0, alpha: 0.38).cgColor
    v.addSubview(t, positioned: .below, relativeTo: nil)
}

func statusColor(_ s: String) -> NSColor {
    switch s {
    case "waiting": return NSColor(srgbRed: 1.0, green: 0.66, blue: 0.25, alpha: 1)
    case "failed", "error": return NSColor(srgbRed: 1.0, green: 0.42, blue: 0.42, alpha: 1)
    case "review": return NSColor(srgbRed: 0.42, green: 0.85, blue: 0.55, alpha: 1)
    default: return NSColor(srgbRed: 0.55, green: 0.72, blue: 1.0, alpha: 1)   // running/starting/info
    }
}

func symbol(_ name: String, size: CGFloat, weight: NSFont.Weight = .semibold, color: NSColor = .white,
            glyph: NSColor? = nil) -> NSImage? {
    // `glyph`: cor da camada de cima nos símbolos .fill (o "!" do triângulo, o check do
    // círculo). Com uma cor só, a paleta pinta as duas camadas iguais e o glifo some.
    let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
        .applying(NSImage.SymbolConfiguration(paletteColors: glyph.map { [$0, color] } ?? [color]))
    return NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
}

func label(_ font: NSFont, _ color: NSColor) -> NSTextField {
    let l = NSTextField(labelWithString: "")
    l.font = font; l.textColor = color
    l.lineBreakMode = .byTruncatingTail
    l.maximumNumberOfLines = 1
    l.cell?.truncatesLastVisibleLine = true
    return l
}

final class ClosureItem: NSMenuItem {
    private let block: () -> Void
    init(_ title: String, _ block: @escaping () -> Void) {
        self.block = block
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError() }
    @objc private func fire() { block() }
}

// popUpContextMenu não abre com o app inativo (caso permanente aqui);
// popUp(positioning:) roda o laço de rastreio próprio.
func popMenu(_ items: [(String, () -> Void)], at p: NSPoint, in view: NSView) {
    let m = NSMenu()
    for (t, b) in items { m.addItem(ClosureItem(t, b)) }
    m.popUp(positioning: nil, at: p, in: view)
}

// MARK: - Botões desenhados (leves, sem NSButton)

class FlatButton: NSView {
    var onTap: (() -> Void)?
    var pressed = false { didSet { needsDisplay = true } }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) { pressed = true }
    override func mouseUp(with e: NSEvent) {
        let inside = bounds.contains(convert(e.locationInWindow, from: nil))
        pressed = false
        if inside { onTap?() }
    }
}

final class TextButton: FlatButton {
    let text: String
    private let font = NSFont.systemFont(ofSize: 12, weight: .medium)
    init(_ text: String) {
        self.text = text
        super.init(frame: .zero)
        setAccessibilityLabel(text)
    }
    required init?(coder: NSCoder) { fatalError() }
    var fitWidth: CGFloat { ceil((text as NSString).size(withAttributes: [.font: font]).width) + 22 }
    override func draw(_ r: NSRect) {
        NSColor(white: 1, alpha: pressed ? 0.30 : 0.16).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
        let s = (text as NSString)
        let sz = s.size(withAttributes: [.font: font])
        s.draw(at: NSPoint(x: (bounds.width - sz.width) / 2, y: (bounds.height - sz.height) / 2),
               withAttributes: [.font: font, .foregroundColor: NSColor.white])
    }
}

final class IconButton: FlatButton {
    var symbolName: String { didSet { needsDisplay = true } }
    var fill = NSColor(white: 0.08, alpha: 0.82)
    private let pt: CGFloat
    init(symbol: String, size: CGFloat, label: String) {
        symbolName = symbol; pt = size
        super.init(frame: .zero)
        setAccessibilityLabel(label)
        toolTip = label
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ r: NSRect) {
        (pressed ? fill.withAlphaComponent(1) : fill).setFill()
        NSBezierPath(ovalIn: bounds).fill()
        NSColor(white: 1, alpha: 0.18).setStroke()
        let b = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.25, dy: 0.25)); b.lineWidth = 0.5; b.stroke()
        if let img = symbol(symbolName, size: pt, weight: .bold) {
            let s = img.size
            img.draw(in: NSRect(x: (bounds.width - s.width) / 2, y: (bounds.height - s.height) / 2, width: s.width, height: s.height))
        }
    }
}

// MARK: - Pílula

struct Pill: Equatable {
    var id: String
    var status: String
    var title: String
    var subtitle: String
    var canReply: Bool
    var canStop: Bool
    var local = false      // saudação: não existe no main
}

func defaultSubtitle(_ status: String) -> String {
    switch status {
    case "running": return "Pensando"
    case "waiting": return "Requer input"
    case "failed": return "Bloqueada"
    case "review": return "Pronto"
    case "starting": return "Iniciando sua tarefa"
    case "error": return "Não foi possível iniciar o chat"
    default: return ""
    }
}

protocol PillActions: AnyObject {
    func pillOpen(_ id: String)
    func pillDismiss(_ id: String)
    func pillMute(_ id: String)
    func pillReply(_ id: String, _ text: String)
    func pillStop(_ id: String)
    func pillExpand()
}

final class PillCard: NSVisualEffectView, NSTextFieldDelegate {
    static let height: CGFloat = 58
    static let greetHeight: CGFloat = 76
    static func height(of p: Pill) -> CGFloat { p.local ? greetHeight : height }
    private(set) var pill: Pill
    weak var actions: PillActions?
    var stackCollapsed = false { didSet { if oldValue != stackCollapsed { hovered = false; relayout() } } }

    private let icon = NSImageView()
    private let titleL = label(.systemFont(ofSize: 13, weight: .semibold), .white)
    private let subL = label(.systemFont(ofSize: 13), NSColor(white: 1, alpha: 0.62))
    private let closeB = IconButton(symbol: "xmark", size: 8, label: "")
    private let replyB = TextButton("Responder")
    private let stopB = TextButton("Parar")
    private let replyF = NSTextField()
    private var hovered = false
    private(set) var replying = false
    private var ovr: (text: String, error: Bool)?
    private var overrideWork: DispatchWorkItem?
    private var downPoint: NSPoint?

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init(_ p: Pill) {
        pill = p
        super.init(frame: NSRect(x: 0, y: 0, width: 330, height: PillCard.height(of: p)))
        material = .hudWindow; blendingMode = .behindWindow; state = .active
        wantsLayer = true
        layer?.cornerRadius = 16; layer?.cornerCurve = .continuous; layer?.masksToBounds = true
        layer?.borderWidth = 0.5; layer?.borderColor = NSColor(white: 1, alpha: 0.14).cgColor

        icon.imageScaling = .scaleProportionallyDown
        replyF.isBordered = false; replyF.drawsBackground = false; replyF.focusRingType = .none
        replyF.font = .systemFont(ofSize: 13); replyF.textColor = .white
        replyF.placeholderAttributedString = NSAttributedString(
            string: "Dar continuidade",
            attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor(white: 1, alpha: 0.45)])
        replyF.cell?.usesSingleLineMode = true
        replyF.delegate = self
        replyF.isHidden = true
        addTint(self)
        for v in [icon, titleL, subL, replyF, closeB, replyB, stopB] as [NSView] { addSubview(v) }
        closeB.isHidden = true; replyB.isHidden = true; stopB.isHidden = true
        closeB.onTap = { [weak self] in guard let s = self else { return }; s.actions?.pillDismiss(s.pill.id) }
        replyB.onTap = { [weak self] in self?.beginReply() }
        stopB.onTap = { [weak self] in guard let s = self else { return }; s.actions?.pillStop(s.pill.id) }
        update(p)
    }
    required init?(coder: NSCoder) { fatalError() }

    func update(_ p: Pill) {
        pill = p
        if p.local {
            subL.maximumNumberOfLines = 2; subL.lineBreakMode = .byWordWrapping
            subL.cell?.wraps = true
        }
        titleL.stringValue = p.title.isEmpty ? "Novo chat" : p.title
        closeB.setAccessibilityLabel("Fechar \(titleL.stringValue)")
        closeB.toolTip = "Fechar \(titleL.stringValue)"
        replyB.setAccessibilityLabel("Responder a \(titleL.stringValue)")
        stopB.setAccessibilityLabel("Parar \(titleL.stringValue)")
        let name: String
        switch p.status {
        case "waiting", "failed", "error": name = "exclamationmark.triangle.fill"
        case "review": name = "checkmark.circle.fill"
        case "running", "starting": name = NSImage(systemSymbolName: "progress.indicator", accessibilityDescription: nil) != nil ? "progress.indicator" : "circle.dotted"
        default: name = "clock.fill"
        }
        icon.image = symbol(name, size: 14, color: statusColor(p.status),
                            glyph: name.hasSuffix(".fill") ? NSColor(white: 0.08, alpha: 1) : nil)
        refreshSubtitle()
        relayout()
    }

    private func refreshSubtitle() {
        if let o = ovr {
            subL.stringValue = o.text
            subL.textColor = o.error ? statusColor("failed") : NSColor(white: 1, alpha: 0.62)
        } else {
            subL.stringValue = pill.subtitle.isEmpty ? defaultSubtitle(pill.status) : pill.subtitle
            subL.textColor = NSColor(white: 1, alpha: 0.62)
        }
    }

    /// Texto temporário no lugar do subtítulo ("Direcionando" 3 s; erros 5 s).
    func flash(_ text: String, error: Bool, seconds: Double) {
        ovr = (text, error)
        refreshSubtitle(); relayout()
        overrideWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            self?.ovr = nil; self?.refreshSubtitle(); self?.relayout()
        }
        overrideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
    }

    override func setFrameSize(_ s: NSSize) { super.setFrameSize(s); relayout() }

    func relayout() {
        let w = bounds.width
        let chrome = hovered && !stackCollapsed && !replying
        let tx: CGFloat = 46
        icon.frame = NSRect(x: 22, y: 10, width: 18, height: 17)
        titleL.frame = NSRect(x: tx, y: 9, width: max(0, w - tx - 14), height: 17)
        closeB.frame = NSRect(x: 4, y: 4, width: 16, height: 16)
        closeB.isHidden = !(hovered && !stackCollapsed)
        var btnW: CGFloat = 0
        let showReply = chrome && pill.canReply
        let showStop = chrome && pill.canStop
        replyB.isHidden = !showReply; stopB.isHidden = !showStop
        var x = w - 12
        if showStop {
            let bw = stopB.fitWidth
            x -= bw; stopB.frame = NSRect(x: x, y: 27, width: bw, height: 21); x -= 6; btnW += bw + 6
        }
        if showReply {
            let bw = replyB.fitWidth
            x -= bw; replyB.frame = NSRect(x: x, y: 27, width: bw, height: 21); btnW += bw + 6
        }
        subL.isHidden = replying
        subL.frame = NSRect(x: tx, y: 29, width: max(0, w - tx - 14 - btnW), height: pill.local ? 36 : 17)
        replyF.isHidden = !replying
        replyF.frame = NSRect(x: tx, y: 28, width: max(0, w - tx - 14), height: 19)
    }

    // MARK: hover

    override func updateTrackingAreas() {
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
        super.updateTrackingAreas()
    }
    override func mouseEntered(with e: NSEvent) { if !stackCollapsed { hovered = true; relayout() } }
    override func mouseExited(with e: NSEvent) { hovered = false; relayout() }

    // MARK: clique / menu

    override func mouseDown(with e: NSEvent) { downPoint = e.locationInWindow }
    override func mouseUp(with e: NSEvent) {
        guard let d = downPoint else { return }
        downPoint = nil
        if hypot(e.locationInWindow.x - d.x, e.locationInWindow.y - d.y) > 4 { return }
        if replying { return }
        if stackCollapsed { actions?.pillExpand() } else { actions?.pillOpen(pill.id) }
    }
    override func rightMouseDown(with e: NSEvent) {
        guard !pill.local else { return }
        popMenu([("Silenciar tarefa", { [weak self] in guard let s = self else { return }; s.actions?.pillMute(s.pill.id) })],
                at: convert(e.locationInWindow, from: nil), in: self)
    }

    // MARK: resposta inline

    private func beginReply() {
        replying = true
        replyF.stringValue = ""
        relayout()
        window?.makeKey()
        window?.makeFirstResponder(replyF)
    }

    func cancelReply() {
        guard replying else { return }
        replying = false
        releaseKey()
        relayout()
    }

    /// Devolve o teclado ao app da frente (como o blurChat da barra). Só tirar o
    /// first responder deixava o painel key e engolia as próximas teclas.
    private func releaseKey() {
        guard let w = window else { return }
        w.makeFirstResponder(nil)
        if w.isKeyWindow { w.resignKey() }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) {
            let t = replyF.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty {
                replying = false
                releaseKey()
                if pill.status == "running" { flash("Direcionando", error: false, seconds: 3) } else { relayout() }
                actions?.pillReply(pill.id, t)
            }
            return true
        }
        if sel == #selector(NSResponder.cancelOperation(_:)) { cancelReply(); return true }
        return false
    }
}

/// Cartão de trás da pilha: só uma forma barata (sem vidro por cima de vidro).
final class BehindCard: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 16; layer?.cornerCurve = .continuous
        layer?.backgroundColor = NSColor(white: 0.16, alpha: 0.78).cgColor
        layer?.borderWidth = 0.5; layer?.borderColor = NSColor(white: 1, alpha: 0.10).cgColor
    }
    required init?(coder: NSCoder) { fatalError() }
}

// MARK: - Bandeja

final class TrayView: NSView {
    static let width: CGFloat = 330
    static let gap: CGFloat = 6
    static let maxExpanded: CGFloat = 208
    static let peek: CGFloat = 6

    weak var actions: PillActions?
    private var cards: [String: PillCard] = [:]
    private let behind = [BehindCard(frame: .zero), BehindCard(frame: .zero)]
    private let scroll = NSScrollView()
    private let doc = FlippedView()

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        behind.forEach { addSubview($0); $0.isHidden = true }
        scroll.hasVerticalScroller = false; scroll.hasHorizontalScroller = false
        scroll.drawsBackground = false; scroll.borderType = .noBorder
        scroll.verticalScrollElasticity = .allowed
        scroll.documentView = doc
    }
    required init?(coder: NSCoder) { fatalError() }

    static func height(_ pills: [Pill], expanded: Bool) -> CGFloat {
        guard let first = pills.first else { return 0 }
        let fh = PillCard.height(of: first)
        if pills.count == 1 { return fh }
        if expanded { return min(content(pills), maxExpanded) }
        return fh + peek * CGFloat(min(pills.count - 1, 2))
    }
    private static func content(_ pills: [Pill]) -> CGFloat {
        pills.reduce(0) { $0 + PillCard.height(of: $1) } + CGFloat(pills.count - 1) * gap
    }

    func card(_ id: String) -> PillCard? { cards[id] }
    func cancelReplies() { cards.values.forEach { $0.cancelReply() } }

    /// `awayUp`: a bandeja está acima do mascote (os cartões de trás espiam para cima).
    func update(_ pills: [Pill], expanded: Bool, awayUp: Bool) {
        let ids = Set(pills.map { $0.id })
        for (id, c) in cards where !ids.contains(id) { c.removeFromSuperview(); cards[id] = nil }
        for p in pills {
            if let c = cards[p.id] { c.update(p) }
            else { let c = PillCard(p); c.actions = actions; cards[p.id] = c }
        }
        let n = pills.count
        let W = TrayView.width
        if n > 1 && expanded {
            behind.forEach { $0.isHidden = true }
            if scroll.superview == nil { addSubview(scroll) }
            let contentH = TrayView.content(pills)
            doc.frame = NSRect(x: 0, y: 0, width: W, height: contentH)
            scroll.frame = NSRect(x: 0, y: 0, width: W, height: min(contentH, TrayView.maxExpanded))
            var y: CGFloat = 0
            for p in pills {
                guard let c = cards[p.id] else { continue }
                c.stackCollapsed = false
                if c.superview !== doc { doc.addSubview(c) }
                let h = PillCard.height(of: p)
                c.frame = NSRect(x: 0, y: y, width: W, height: h)
                y += h + TrayView.gap
            }
        } else {
            scroll.removeFromSuperview()
            let peeks = min(max(n - 1, 0), 2)
            let fh = pills.first.map { PillCard.height(of: $0) } ?? PillCard.height
            for k in 0..<2 {
                let b = behind[k]
                b.isHidden = k >= peeks
                if k < peeks {
                    let s = 1 - 0.04 * CGFloat(k + 1)
                    let off = TrayView.peek * CGFloat(k + 1)
                    let y = awayUp ? TrayView.peek * CGFloat(peeks) - off : off
                    b.frame = NSRect(x: (W - W * s) / 2, y: y, width: W * s, height: fh)
                }
            }
            for (i, p) in pills.enumerated() {
                guard let c = cards[p.id] else { continue }
                if i == 0 {
                    c.stackCollapsed = n > 1
                    if c.superview !== self { addSubview(c) }
                    c.frame = NSRect(x: 0, y: awayUp ? TrayView.peek * CGFloat(peeks) : 0, width: W, height: fh)
                } else if c.superview != nil {
                    c.removeFromSuperview()
                }
            }
        }
        setAccessibilityLabel("Notificações de atividade")
    }
}

final class FlippedView: NSView { override var isFlipped: Bool { true } }

// MARK: - Barra de chat

final class ChatField: NSTextField {
    var onBecome: (() -> Void)?
    override func becomeFirstResponder() -> Bool {
        let r = super.becomeFirstResponder()
        if r { onBecome?() }
        return r
    }
}

final class ChatBar: NSVisualEffectView {
    static let height: CGFloat = 36
    let field = ChatField()
    var onDragStart: ((NSEvent) -> Void)?
    var onDrag: ((NSEvent) -> Void)?
    var onDragEnd: ((NSEvent) -> Void)?
    var onMenu: ((NSEvent) -> Void)?

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 85, height: ChatBar.height))
        material = .hudWindow; blendingMode = .behindWindow; state = .active
        wantsLayer = true
        layer?.cornerRadius = ChatBar.height / 2; layer?.cornerCurve = .continuous; layer?.masksToBounds = true
        layer?.borderWidth = 0.5; layer?.borderColor = NSColor(white: 1, alpha: 0.14).cgColor
        field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none
        field.font = .systemFont(ofSize: 13); field.textColor = .white
        field.cell?.usesSingleLineMode = true
        field.cell?.isScrollable = true
        field.setAccessibilityLabel("Chat")
        addTint(self)
        addSubview(field)
        setPlaceholder("Perguntar")
    }
    required init?(coder: NSCoder) { fatalError() }

    func setPlaceholder(_ s: String) {
        field.placeholderAttributedString = NSAttributedString(
            string: s, attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor(white: 1, alpha: 0.5)])
    }

    override func setFrameSize(_ s: NSSize) {
        super.setFrameSize(s)
        let pad: CGFloat = s.width < 120 ? 10 : 14
        field.frame = NSRect(x: pad, y: (s.height - 18) / 2, width: max(0, s.width - pad * 2), height: 18)
    }

    // O fundo do vidro arrasta o Mini (útil no modo "None", sem mascote).
    override func mouseDown(with e: NSEvent) { onDragStart?(e) }
    override func mouseDragged(with e: NSEvent) { onDrag?(e) }
    override func mouseUp(with e: NSEvent) { onDragEnd?(e) }
    override func rightMouseDown(with e: NSEvent) { onMenu?(e) }
}

// MARK: - Mascote

final class MascotView: NSView {
    var onHover: ((Bool) -> Void)?
    var onClick: (() -> Void)?
    var onDragStart: ((NSEvent) -> Void)?
    var onDrag: ((NSEvent) -> Void)?
    var onDragEnd: ((NSEvent) -> Void)?
    var onMenu: ((NSEvent) -> Void)?
    private var downAt: NSPoint?
    private var moved = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var isFlipped: Bool { false }

    override func updateTrackingAreas() {
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
        super.updateTrackingAreas()
    }
    override func mouseEntered(with e: NSEvent) { NSCursor.openHand.set(); onHover?(true) }
    override func mouseExited(with e: NSEvent) { NSCursor.arrow.set(); onHover?(false) }
    override func rightMouseDown(with e: NSEvent) { onMenu?(e) }

    override func mouseDown(with e: NSEvent) {
        if e.modifierFlags.contains(.control) { onMenu?(e); return }
        downAt = window?.convertPoint(toScreen: e.locationInWindow)
        moved = false
        NSCursor.closedHand.set()
        onDragStart?(e)
    }
    override func mouseDragged(with e: NSEvent) {
        guard let d = downAt, let w = window else { return }
        let p = w.convertPoint(toScreen: e.locationInWindow)
        if !moved && hypot(p.x - d.x, p.y - d.y) < 4 { return }
        moved = true
        onDrag?(e)
    }
    override func mouseUp(with e: NSEvent) {
        guard downAt != nil else { return }
        downAt = nil
        NSCursor.openHand.set()
        if moved { onDragEnd?(e) } else { onClick?() }
    }
}

// MARK: - Badge arrastável

final class BadgeView: NSView {
    static let size: CGFloat = 22
    var count = 0 { didSet { needsDisplay = true } }
    var color = statusColor("running") { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    var onDropped: ((NSPoint) -> Void)?      // centro, em coordenadas do superview
    private var downAt: NSPoint?
    private var startOrigin: NSPoint = .zero
    private var moved = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ r: NSRect) {
        color.setFill()
        NSBezierPath(ovalIn: bounds).fill()
        let s = "\(count)" as NSString
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12, weight: .bold),
                                                    .foregroundColor: NSColor(white: 0.08, alpha: 1)]
        let sz = s.size(withAttributes: attrs)
        s.draw(at: NSPoint(x: (bounds.width - sz.width) / 2, y: (bounds.height - sz.height) / 2), withAttributes: attrs)
    }

    override func mouseDown(with e: NSEvent) {
        guard let sv = superview else { return }
        downAt = sv.convert(e.locationInWindow, from: nil)
        startOrigin = frame.origin; moved = false
    }
    override func mouseDragged(with e: NSEvent) {
        guard let sv = superview, let d = downAt else { return }
        let p = sv.convert(e.locationInWindow, from: nil)
        if !moved && hypot(p.x - d.x, p.y - d.y) < 4 { return }
        moved = true
        setFrameOrigin(NSPoint(x: startOrigin.x + p.x - d.x, y: startOrigin.y + p.y - d.y))
    }
    override func mouseUp(with e: NSEvent) {
        downAt = nil
        if moved { onDropped?(NSPoint(x: frame.midX, y: frame.midY)) } else { onClick?() }
    }
}
