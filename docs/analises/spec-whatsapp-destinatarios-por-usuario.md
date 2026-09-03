# WhatsApp — destinatários vinculados a usuário

## Contrato

- `recipients` é a fonte única dos números de WhatsApp.
- Cada destinatário pertence a exatamente um usuário (`userId`). Um usuário pode possuir vários.
- No máximo um destinatário por usuário é `principal`. Não existe promoção automática ao apagar
  ou desmarcar o principal.
- “Meu perfil” lê e altera somente o principal do usuário autenticado: criar o primeiro cadastro
  cria o principal; editar mantém o mesmo `id`; limpar o número apaga esse destinatário.
- O superadmin vê todos os destinatários, pode transferir o proprietário e marcar o principal.
- O comportamento preexistente de número repetido não muda: `create` rejeita número normalizado já
  cadastrado. Esta frente não adiciona outra regra de deduplicação.
- O envio resolve o proprietário no momento do alerta. Usuário inexistente/inativo, destinatário
  inativo ou sem consentimento não recebe. Papel `cliente` recebe somente das câmeras atuais em
  `cameraIds`; papéis de equipe recebem de todas.

## Migração no boot

1. O cache de usuários é carregado antes de destinatários.
2. Números legados de perfil viram o principal do próprio usuário, preservando filtros, datas e
   consentimento.
3. Destinatários avulsos sem proprietário são vinculados ao primeiro superadmin real do estado.
4. Se esse admin não tinha número de perfil, o destinatário mais antigo dele vira principal.
5. `recipientMigrationVersion=1` impede reaplicar os campos legados em boots futuros; os campos
   antigos permanecem preservados para rollback.

No Postgres, vínculos, principais e marcadores são gravados em uma única transação. No fallback
JSON, `recipients.pre-user-link.bak.json` guarda o estado anterior e qualquer falha tenta restaurar
o arquivo e sempre restaura o cache. Conflito de propriedade ou ausência de superadmin aborta a
migração explicitamente; não existe escolha silenciosa de dono.

## Rollback operacional

Antes de qualquer deploy, deve-se manter o snapshot do volume `/data`. Para rollback da aplicação,
retorna-se à imagem anterior. No JSON, o arquivo `.bak.json` permite restaurar os destinatários;
`users.json` conserva os campos legados. No Postgres, a transação desfaz falhas durante a migração e
os campos legados de `users` continuam disponíveis para uma reversão planejada.

Não executar a migração diretamente no estado de produção fora do boot controlado e sem revisar o
snapshot/backup.
