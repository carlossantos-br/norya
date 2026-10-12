# Norya

**Um app de desktop para todos os seus agentes de código.** O Norya roda
Codex, Claude Code, Grok, OpenCode e Aider lado a lado, em quantas contas você
tiver, e mostra em tempo real quanto resta de cada assinatura.

[English](README.md) · [Licença MIT](LICENSE)

## O que faz

- **Perfis.** Cada perfil é uma conta isolada (uma pasta pessoal própria para as
  CLIs), com nome e cor. Abra uma sessão por perfil, ou várias, e troque de
  conta sem deslogar.
- **Grade de sessões.** As sessões abrem como painéis numa grade: terminais de
  verdade (xterm.js + node-pty) ou uma vista de chat para Claude Code e Codex,
  com anexos, fila de mensagens, comandos `/`, arquivos com `@` e uso do
  contexto.
- **Cota ao vivo.** Limites de sessão e semanais por perfil e por provider
  (Codex pelo `codex app-server`, Claude pelo mesmo endpoint que o `/usage` da
  CLI usa, Grok pela TUI), com horário de reset.
- **Fila de atenção.** Som e badge quando um agente termina ou precisa de você,
  a partir dos eventos dos próprios agentes (hooks do Claude, rollouts do
  Codex), sem adivinhar pela saída do terminal.
- **Navegador embutido com automação.** Um navegador dentro do app que os
  agentes controlam por um servidor MCP (`norya-browser`): preview e teste de
  página ficam no Norya. `open <url>` de qualquer agente também cai nele.
- **Workspaces.** Worktree git opcional por thread, fork de uma sessão para uma
  branch nova e fila de merge.
- **Skills compartilhadas.** Uma biblioteca de skills para todos os providers: o
  Norya encontra os `SKILL.md` de todos os agentes instalados e liga ou desliga
  cada um para todos de uma vez.
- **Atualizações e estatísticas.** Avisa de versão nova das CLIs e conta tokens
  pelos logs locais dos agentes, com o custo equivalente de API.
- **Mini (macOS).** Um mascote flutuante que mostra o que os agentes estão
  fazendo enquanto o Norya está em segundo plano.

## ⚠️ Os agentes rodam com acesso total

O Norya foi feito para um desenvolvedor na própria máquina. **As sessões sobem
sem pedir aprovação**: o Claude Code recebe `--dangerously-skip-permissions` e
os perfis novos do Codex nascem com `approval_policy = "never"` e
`sandbox_mode = "danger-full-access"`. Na vista de chat dá para escolher um modo
mais restrito por sessão. Não aponte o Norya para código ou pastas em que você
não confia.

## Requisitos

- **macOS** (desenvolvido e testado em Apple silicon) ou **Windows** 10 (1809+) / 11 x64.
- **Node.js** LTS e **git**.
- As CLIs de agente que você quiser usar, instaladas à parte (o Norya não as
  instala): por exemplo `npm install -g @anthropic-ai/claude-code @openai/codex`.

## Rodar a partir do código

```sh
npm install
npm start
```

Os dados ficam em `~/.norya` (`%USERPROFILE%\.norya` no Windows): perfis,
threads, cache de cota e configurações. As credenciais ficam exatamente onde cada
CLI as grava: a pasta do perfil, ou o Keychain do macOS no caso do Claude.

## Instalador do Windows

```sh
npm run dist:win   # gera dist/Norya-Setup-<versão>-x64.exe (gerado e conferido no macOS)
```

O instalador é por usuário (sem administrador) e não é assinado, então o
SmartScreen avisa na primeira execução. Veja [docs/windows.md](docs/windows.md)
para o que muda em relação ao macOS.

## Testes

```sh
npm run test:unit                 # unitários puros, segundos, sem Electron
node quota/test/index.test.js     # cada teste de quota/ e browser/ também roda sozinho
```

Os `test/smoke-*.js` dirigem o app de verdade pelo Chrome DevTools Protocol; veja
[test/README.md](test/README.md).

## Sprites do Mini

O Mini usa o sprite do Clawd do Claude.app e o do Codex do ChatGPT.app. Essas
imagens são dos seus donos e **não** estão neste repositório. Se você tem os
apps instalados, `python3 tools/pet-assets.py` extrai os sprites para
`assets/pet/`, para uso local; sem eles, o Mini fica desligado.

## Sem vínculo

O Norya é um projeto independente, sem vínculo ou endosso da Anthropic, da
OpenAI, da xAI ou de qualquer outro provider. Claude, Codex, Grok e os demais
nomes pertencem aos seus donos.

## Licença

[MIT](LICENSE)
