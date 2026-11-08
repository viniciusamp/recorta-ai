import UIKit
import WebKit

/// Tela única do app: mostra o Recorta Aí (o mesmo do site) e atende os
/// pedidos que só um app consegue fazer: guardar pacotes, compartilhar
/// arquivos e mandar o pacote para o WhatsApp.
final class WebViewController: UIViewController, WKScriptMessageHandlerWithReply, WKUIDelegate {
    private var webView: WKWebView!
    private let store = PackStore()
    private let background = UIColor(red: 0x16 / 255, green: 0x12 / 255, blue: 0x1F / 255, alpha: 1)

    // Formato oficial (repositório WhatsApp/stickers, Interoperability.swift).
    private let whatsAppPasteboardType = "net.whatsapp.third-party.sticker-pack"
    private let whatsAppURL = URL(string: "whatsapp://stickerPack")!

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(LocalSchemeHandler(), forURLScheme: LocalSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "recorta")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = background
        webView.load(URLRequest(url: URL(string: "\(LocalSchemeHandler.scheme)://app/index.html")!))
    }

    // MARK: - Pedidos vindos da página

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            replyHandler(nil, "Pedido inválido")
            return
        }

        switch cmd {
        case "info":
            replyHandler(["platform": "ios", "whatsapp": canOpenWhatsApp()], nil)

        case "listPacks":
            DispatchQueue.global(qos: .userInitiated).async {
                let packs = self.store.list()
                DispatchQueue.main.async { replyHandler(packs, nil) }
            }

        case "savePack":
            guard let id = body["id"] as? String, let json = body["json"] as? String else {
                replyHandler(nil, "Pacote inválido")
                return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                let ok = self.store.save(id: id, json: json)
                DispatchQueue.main.async { ok ? replyHandler(true, nil) : replyHandler(nil, "Não consegui salvar o pacote") }
            }

        case "deletePack":
            guard let id = body["id"] as? String else {
                replyHandler(nil, "Pacote inválido")
                return
            }
            replyHandler(store.delete(id: id), nil)

        case "sendToWhatsApp":
            guard let json = body["json"] as? String, let data = json.data(using: .utf8) else {
                replyHandler(nil, "Pacote inválido")
                return
            }
            sendToWhatsApp(data, reply: replyHandler)

        case "share":
            guard let files = body["files"] as? [[String: Any]] else {
                replyHandler(nil, "Nada para compartilhar")
                return
            }
            share(files, reply: replyHandler)

        default:
            replyHandler(nil, "Pedido desconhecido: \(cmd)")
        }
    }

    private func canOpenWhatsApp() -> Bool {
        UIApplication.shared.canOpenURL(URL(string: "whatsapp://")!)
    }

    /// Igual ao app de exemplo oficial do WhatsApp: põe o pacote na área de
    /// transferência (só neste aparelho, por 60 s) e abre o WhatsApp.
    private func sendToWhatsApp(_ data: Data, reply: @escaping (Any?, String?) -> Void) {
        guard canOpenWhatsApp() else {
            reply(nil, "Não encontrei o WhatsApp neste iPhone.")
            return
        }
        UIPasteboard.general.setItems(
            [[whatsAppPasteboardType: data]],
            options: [
                UIPasteboard.OptionsKey.localOnly: true,
                UIPasteboard.OptionsKey.expirationDate: Date(timeIntervalSinceNow: 60),
            ]
        )
        UIApplication.shared.open(whatsAppURL, options: [:]) { opened in
            reply(opened, nil)
        }
    }

    /// Abre o "Compartilhar" do iOS (Salvar imagem, AirDrop, etc.).
    private func share(_ files: [[String: Any]], reply: @escaping (Any?, String?) -> Void) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("compartilhar", isDirectory: true)
        try? FileManager.default.removeItem(at: tmp)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        var urls: [URL] = []
        for f in files {
            guard let name = f["name"] as? String,
                  let b64 = f["base64"] as? String,
                  let data = Data(base64Encoded: b64) else { continue }
            let safe = name.replacingOccurrences(of: "/", with: "_")
            let url = tmp.appendingPathComponent(safe)
            if (try? data.write(to: url)) != nil { urls.append(url) }
        }
        guard !urls.isEmpty else {
            reply(nil, "Nada para compartilhar")
            return
        }
        let vc = UIActivityViewController(activityItems: urls, applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = view
        vc.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
        vc.completionWithItemsHandler = { _, completed, _, _ in reply(completed, nil) }
        present(vc, animated: true)
    }

    // MARK: - alert/confirm/prompt do JavaScript

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
}
