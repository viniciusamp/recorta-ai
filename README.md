# ✂ Recorta Aí

Transforma **prints e gravações de tela** (do TikTok ou de qualquer app) em
**figurinhas para o WhatsApp**. Grátis, sem anúncio e sem servidor: tudo roda
no próprio celular, dentro do navegador.

## App para iPhone (pacotes direto no WhatsApp)

O site sozinho não consegue mandar pacotes para o WhatsApp: só um app instalado
consegue. Por isso existe o app do Recorta Aí, que roda as mesmas telas do site e
acrescenta o botão **Adicionar ao WhatsApp**.

O que dá para fazer no app:

- montar **pacotes** (3 a 30 figurinhas, todas paradas ou todas animadas);
- escolher **vários prints/vídeos de uma vez**: o app recorta tudo sozinho;
- figurinhas **animadas de verdade** (WebP animado, como o WhatsApp exige);
- trocar o **emoji** de cada figurinha e escolher o **ícone** do pacote;
- **Adicionar ao WhatsApp**: o WhatsApp abre pedindo para confirmar o pacote.

### Instalar de graça (SideStore)

O GitHub gera o app sozinho a cada mudança (aba **Actions** → "App iPhone") e
publica o arquivo em **Releases**:
`https://github.com/viniciusamp/recorta-ai/releases/latest/download/RecortaAi.ipa`

Para instalar sem pagar a Apple, use o [SideStore](https://docs.sidestore.io/docs/installation/prerequisites)
com o seu Apple ID:

1. **No iPhone**: instale o app **LocalDevVPN** (App Store).
2. **No computador** (Windows ou Mac): instale o **iloader** (e, no Windows, o **iTunes**),
   ligue o iPhone no cabo e use o iloader para instalar o **SideStore** com seu Apple ID.
   Siga o [guia oficial](https://docs.sidestore.io/docs/installation/prerequisites).
3. **No iPhone**: em Ajustes → Geral → VPN e Gerenciamento de Dispositivo, confie no seu
   Apple ID. Ative o **Modo Desenvolvedor** se o iPhone pedir.
4. **No iPhone**: abra o link do `RecortaAi.ipa` acima no Safari, baixe, toque em
   Compartilhar → **SideStore** (ou, no SideStore, "+" e escolha o arquivo). Deixe o
   LocalDevVPN ligado na hora de instalar.

Com Apple ID gratuito, o app vale **7 dias**: abra o SideStore (com o LocalDevVPN ligado)
e toque em **Refresh** para renovar, sem computador. Seus pacotes ficam guardados.

## Como usar no navegador (sem app)

1. Abra `https://viniciusamp.github.io/recorta-ai/` no **Safari** → Compartilhar →
   **Adicionar à Tela de Início**.
2. Mande prints ou gravações; monte os pacotes normalmente.
3. Sem o app, use **Salvar todas** e crie as figurinhas pelo próprio WhatsApp
   (figurinhas → ＋ Criar).

## Como funciona

Sem inteligência artificial pesada, só processamento de imagem:

1. **Fundo**: descobre as cores lisas dominantes da tela (o fundo dos comentários).
2. **Objetos**: tudo que não é fundo vira um "objeto" (componentes conectados).
3. **Nota**: cada objeto ganha uma nota. Ganha ponto quem for grande, quadradinho, colorido
   e (no vídeo) se mexendo. Perde ponto texto, coisa colada na borda da tela e o vídeo do topo.
4. **Recorte**: o fundo ligado às bordas vira transparente, com borda suave. Letras e
   pedacinhos vizinhos são descartados.
5. **Montagem**: centraliza em 512×512, com borda branca opcional, e exporta PNG ou GIF.

Na gravação de tela, o site acha o trecho em que a tela **não rolou**, junta os quadros e usa
o movimento para achar a figurinha animada.

## Rodar no computador

É um site estático, sem build:

```bash
python3 -m http.server 8000
# abra http://localhost:8000
```

## Publicar de graça (GitHub Pages)

No repositório: **Settings → Pages → Build and deployment → Deploy from a branch →
`main` / `(root)`**. Em um ou dois minutos o site fica em
`https://<seu-usuario>.github.io/<nome-do-repo>/`.

## Testes

Geram prints e uma gravação de tela falsos (tema escuro e claro, PNG e JPEG, com vídeo
rodando no topo, avatares, textos) e conferem se a figurinha certa é achada e recortada:

```bash
pip install pillow        # e ter o ffmpeg instalado
python3 tests/make_fixtures.py
npm i -D playwright && npx playwright install chromium   # se ainda não tiver
node tests/run.cjs      # detecção e recorte
node tests/packs.cjs    # pacotes + JSON do WhatsApp (simula o app do iPhone)
```

## Estrutura

| Arquivo | O que faz |
| --- | --- |
| `index.html`, `css/style.css` | Interface |
| `js/app.js` | Telas, botões, salvar/compartilhar |
| `js/pipeline.js` | Abre imagem/vídeo, analisa quadros, recorta o candidato |
| `js/detect.js` | Fundo, componentes, nota dos candidatos, recorte |
| `js/compose.js` | Monta 512×512, borda branca, PNG/GIF |
| `js/webp.js` | WebP parado/animado nos limites do WhatsApp (libwebp em WebAssembly) |
| `js/packs.js`, `js/store.js` | Pacotes: montar, guardar, validar e mandar pro WhatsApp |
| `js/native.js` | Ponte com o app do iPhone |
| `ios/` | App de iPhone (Swift): mostra o site e manda o pacote pro WhatsApp |
| `.github/workflows/ios.yml` | Gera o `.ipa` numa máquina Mac do GitHub |
| `vendor/gifenc.esm.js` | Encoder de GIF ([gifenc](https://github.com/mattdesl/gifenc), MIT) |
| `vendor/webp/` | Encoder WebP ([libwebp](https://chromium.googlesource.com/webm/libwebp), BSD, via [jSquash](https://github.com/jamsinclair/jSquash), Apache 2.0) |
| `sw.js`, `manifest.webmanifest` | Funciona offline e instala na tela de início |
