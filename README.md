# Toca & Trilha

Protótipo original de plataforma 2D multiplayer: pegue o queijo e volte à toca antes de o tempo acabar. Uma fase, arte desenhada em Canvas, física própria e servidor autoritativo com salas. Feito para testar o conceito do seu jogo; não é uma cópia integral do Transformice e não usa seus arquivos, arte, contas ou servidores.

## Testar no Windows

1. Extraia **todo** o arquivo `Toca-e-Trilha-Windows-x64.zip`.
2. Abra `Toca-e-Trilha.exe` na pasta extraída. Windows 10/11 x64. Não precisa instalar Node.js, npm ou Adobe AIR.
3. Escolha um nome e entre na sala `CLAREIRA`.

O executável abre a janela do jogo e inicia seu servidor em uma porta livre de `127.0.0.1`. Funciona offline. Fechar todas as janelas encerra o servidor. Os arquivos DLL e a pasta `resources` precisam continuar ao lado do executável.

| Ação | Teclas |
|---|---|
| Movimento | A/D ou setas esquerda/direita |
| Salto | Espaço, W ou seta para cima |
| Voltar ao início | R |
| Outra janela para testar multiplayer | Ctrl+N |
| Menu do aplicativo | Alt |

Para testar multiplayer no mesmo computador, abra outra janela com Ctrl+N e entre na mesma sala. Cada janela controla um jogador. Nomes de sala diferentes criam partidas separadas. O teclado controla a janela que estiver em foco.

## Desenvolver ou executar seu próprio servidor

Com Node.js 22.12+:

```bash
npm ci
npm start
```

Abra o endereço informado no terminal. Duas abas na mesma sala permitem testar dois jogadores. Para permitir acesso pela rede local, configure `HOST=0.0.0.0` e `PORT=3000`; os outros computadores usam o endereço IP do computador que iniciou o servidor. O aplicativo Windows portátil é configurado para usar seu servidor local; o código-fonte também pode servir a versão web para outros computadores.

O protótipo não tem contas, persistência, matchmaking público ou infraestrutura de produção. Pontuações e salas ficam em memória e se perdem quando o servidor é encerrado.

## Implementação

- `public/client.js`: entrada, conexão, interpolação, efeitos e arte original.
- `public/shared/game.js`: mapa e regras determinísticas de movimento, salto, colisões, coleta e chegada.
- `server.js`: servidor HTTP/WebSocket, salas, estado autoritativo e rodadas.
- `desktop/main.cjs`: janela desktop e ciclo de vida do servidor local.
- `tests/prototype.test.mjs`: verificações de física e integração multiplayer.

As constantes físicas são escolhas próprias para este protótipo. A cópia de Transformice analisada anteriormente continha apenas um carregador; nenhuma constante, mecânica interna ou protocolo do jogo original foi recuperado para esta implementação.

## Verificar e empacotar

```bash
npm test
npm run package:windows
```

O empacotador usa Python 3 e baixa o runtime oficial **Electron 44.7.0 para Windows x64**, verificando SHA-256 antes de usá-lo. As licenças do runtime permanecem no pacote. Os resultados ficam em `dist/`: o pacote portátil de Windows e um ZIP separado de código-fonte. O cache do runtime fica em `.cache/electron`.

A versão web e o servidor podem ser testados no Linux. O executável de Windows precisa ser testado também no Windows; montar seu pacote e conferir o conteúdo PE não equivale a executá-lo no sistema de destino.
