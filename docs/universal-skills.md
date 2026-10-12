# Biblioteca universal de skills

Skills fica na navegação principal, imediatamente abaixo de Browser. A aba de
Skills saiu das configurações. A biblioteca lista todas as skills locais
descobertas, com busca por nome/descrição/origem, filtros de estado, instalações
agrupadas e uma chave de habilitar/desabilitar válida para todos os providers.

## Catálogo e persistência

`agents/skills.js` lê `SKILL.md` nos diretórios conhecidos de Codex, Claude, Grok,
OpenCode, Aider, `.agents`, Gemini e Cursor. Inclui o HOME real, todos os perfis
numerados de Norya e os projetos registrados/abertos. Lê também caches de plugins,
extensões Gemini e caminhos de plugins registrados em `installed_plugins.json`,
inclusive instalações fora dos caches. Usa `os.userInfo().homedir`: o HOME
herdado de um pane pode ser o diretório de uma conta.

Symlinks são seguidos com proteção contra ciclos. Cópias de mesmo nome/conteúdo
são agrupadas, preservando todas as origens. Versões do mesmo plugin usam a
instalação registrada; sem registro, a versão semântica mais recente ou a data de
modificação. Caches temporários, dependências e fixtures são ignorados. Skills
diferentes com o mesmo nome continuam visíveis. Uma skill sem descrição também
aparece. Erros de leitura aparecem na tela.

`NORYA_HOME/skills/state.json` guarda preferências por família lógica, estáveis
entre versões. `catalog.md` e `catalog.json` são derivados desse estado. A pasta
`NORYA_HOME/skills/local/` também aceita skills compartilhadas. As instalações
originais, recursos, scripts e credenciais ficam no lugar. `ensureConfig` deixou
de apagar uma pasta real de skills de perfil para substituí-la por symlink.

Refresh/toggles/preparação de sessão são serializados. Gravações usam arquivo
temporário e rename. Estado inválido gera erro, sem reativação automática.
Não há timer de varredura: leitura ao abrir/atualizar a biblioteca e ao iniciar
ou retomar uma task. O catálogo exibido tem cache de 15 segundos.

## Uso pelos providers

As integrações aplicam-se a sessões iniciadas pelo Norya. Login continua usando
o comando original. O catálogo oferece instruções portáveis, com referência ao
SKILL.md original para preservar caminhos relativos de recursos.

| Provider | Integração |
| --- | --- |
| Codex | `developer_instructions` acrescenta a leitura do catálogo, preservando o valor preexistente no config do perfil; `skills.config` desabilita as cópias nativas das skills desligadas, incluindo versões antigas. |
| Claude | `--append-system-prompt` aponta ao catálogo; `--disallowedTools Skill` delega o carregamento automático das skills à leitura portátil, preservando os comandos locais `/model`, `/config`, `/usage` e `/rc`; `--system-prompt-snapshot off` aplica a orientação também ao retomar sessões. |
| Grok | `--rules` orienta a consulta do catálogo e o respeito à ativação compartilhada. É uma regra do agente; não modifica `[skills].disabled` do config nativo. |
| OpenCode | `OPENCODE_CONFIG_CONTENT` acrescenta o catálogo a `instructions`, preservando as outras opções, e bloqueia o carregador nativo `skill` para usar leitura portátil. |
| Aider | `--read` carrega só o catálogo. Um adaptador Python da sessão acrescenta `/skill nome` e carrega a skill citada como `$nome` em contexto somente leitura, removendo skills desabilitadas antes do próximo envio. Não injeta todas as instruções de uma vez. |

No Aider, o adaptador usa o Python da própria instalação, via `PYTHONPATH` apenas
no processo iniciado por Norya. `PYTHONDONTWRITEBYTECODE=1` evita que o Python
grave caches no bundle assinado. O entrypoint e o pacote instalado do Aider não
são alterados. O adaptador foi verificado com Aider 0.86.2; alterações nas APIs
internas `Coder.run_one`/`Commands` exigem repetir o smoke das CLIs.

Todos os providers podem usar `$nome-da-skill` no texto da task. O carregamento
portátil não replica ferramentas exclusivas, MCPs autenticados nem serviços de
outro provider. A orientação é usar equivalentes disponíveis e informar
dependências ausentes. Ativação de skills não é uma barreira de acesso a arquivos.
Conteúdo já carregado em uma conversa não pode ser retirado retroativamente;
a aplicação completa das chaves ocorre ao abrir/retomar a task.

## Verificação

- `node test/skills.test.js`: descoberta, perfis/symlinks, deduplicação, versões,
  plugins externos, persistência, concorrência, corrupção e adaptadores.
- `node test/aider-skills.test.js`: carregamento sob demanda e desativação no Aider.
- `node test/smoke-skills.js`: Electron e IPC reais, busca/filtros/toggles,
  persistência, erros/retry, temas e viewport menor. Estado e skills fictícios.
- `node test/smoke-skills-providers.js`: CLIs instaladas em HOME temporário.
  Codex `skills/list` confirma `enabled:false`; Claude/Grok aceitam as opções;
  OpenCode resolve a configuração; Aider recusa `/skill` desligada e carrega a
  mesma skill depois de habilitar. Nenhuma chamada de inferência.
- `npm run test:unit`: regressões do app. O teste de roteamento de auth recebeu
  o stub faltante de `agentShellPrelude`, dependência já usada antes desta mudança.

Auditoria local em 2026-09-11: 182 skills, sem erros de leitura, incluindo
`brainstorming` do Superpowers 6.3.0 do Claude. Origens se sobrepõem porque cópias
iguais são agrupadas: 114 Claude, 68 Codex e 9 Grok.

Os mecanismos do Grok estão documentados em
[Skills, Plugins & Marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces)
e [CLI Reference](https://docs.x.ai/build/cli/reference); a composição do OpenCode,
em [Config](https://opencode.ai/docs/config/). Flags foram verificadas também no
`--help` das instalações locais.

## Entrega

`agents/` e `renderer/` já pertencem à allowlist de `deploy.sh`. Usar
`bash deploy.sh --no-restart` para instalar sem encerrar tasks. O main e renderer
novos entram após encerrar o Norya com ⌘Q e reabri-lo.
