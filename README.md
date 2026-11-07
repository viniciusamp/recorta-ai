# ✂ Recorta Aí

Transforma **prints e gravações de tela** (do TikTok ou de qualquer app) em
**figurinhas para o WhatsApp**. Grátis, sem anúncio e sem servidor: tudo roda
no próprio celular, dentro do navegador.

## Como usar (iPhone)

1. Abra o site no **Safari** → botão de compartilhar → **Adicionar à Tela de Início**.
   Ele vira um ícone igual a um app.
2. No TikTok, deixe a figurinha na tela e **tire um print**. Se for animada,
   **grave a tela** por uns 3 segundos sem rolar.
3. No Recorta Aí, escolha o print ou o vídeo. A figurinha é **encontrada e recortada sozinha**.
   Se ele pegar a coisa errada, toque em outra opção na fileira "Não era essa?".
4. **Salvar figurinha** → **Salvar imagem** (vai para o app Fotos).
5. No WhatsApp: ícone de figurinha → **＋ Criar** → escolha a imagem → envie.

> Animadas: o site gera um GIF animado. No iPhone, o WhatsApp só cria figurinhas a partir de
> imagens paradas, então para virar figurinha use o modo **Parada**. Figurinha animada de verdade
> precisa de um app nativo (ideia para uma fase 2).

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
node tests/run.cjs
```

## Estrutura

| Arquivo | O que faz |
| --- | --- |
| `index.html`, `css/style.css` | Interface |
| `js/app.js` | Telas, botões, salvar/compartilhar |
| `js/pipeline.js` | Abre imagem/vídeo, analisa quadros, recorta o candidato |
| `js/detect.js` | Fundo, componentes, nota dos candidatos, recorte |
| `js/compose.js` | Monta 512×512, borda branca, PNG/GIF |
| `vendor/gifenc.esm.js` | Encoder de GIF ([gifenc](https://github.com/mattdesl/gifenc), MIT) |
| `sw.js`, `manifest.webmanifest` | Funciona offline e instala na tela de início |
