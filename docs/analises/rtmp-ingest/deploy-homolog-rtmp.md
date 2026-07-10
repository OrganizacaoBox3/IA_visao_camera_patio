# Runbook — Ligar o ingest RTMP no homolog (cam.box3.software)

> Como colocar no ar, na VPS de homolog (Ubuntu/DigitalOcean, **compartilhada**), o ingest RTMP
> para câmeras que só fazem **PUSH** (Intelbras/Dahua). Design: [`PENDENCIAS.md`](PENDENCIAS.md) —
> a URL self-referente `rtsp://127.0.0.1:8554/<nome>` no cadastro liga o canal; **zero env no servidor**.
> O RTMP entra por **TCP cru na porta 1935**, direto no go2rtc — **não passa pelo nginx**.

## Passos

1. **Deploy do código** — GitHub Actions, workflow `deploy-homolog.yml` (**disparo manual**,
   `workflow_dispatch`). Ele não mexe em env/unit/nginx — os passos de infra abaixo são à parte.

2. **Firewall da VPS: abrir TCP 1935 inbound** — de preferência **restrito ao(s) IP(s) de origem
   das câmeras** (o publish RTMP do go2rtc é **sem autenticação**: qualquer um que alcance a porta
   consegue publicar vídeo num canal vago — ver "Limites/segurança"). Ex. com ufw:

   ```sh
   sudo ufw allow from <IP_DA_ORIGEM_DAS_CAMERAS> to any port 1935 proto tcp
   ```

   (Se a origem não tiver IP fixo, abrir geral `sudo ufw allow 1935/tcp` é o fallback — aceite o
   risco conscientemente e feche assim que possível.) Lembrar também do firewall da DigitalOcean
   (painel Cloud Firewalls), se houver um na frente do droplet.

3. **DNS** — registro **A** `cam.box3.software` → IP do homolog. (Já confirmado que aponta;
   conferir com `dig +short cam.box3.software` se precisar.)

4. **nginx + TLS — só para o DASHBOARD (https)** — o RTMP **não** passa por aqui.
   Em `deploy/nginx-visao.conf`, o `server_name` ainda é o placeholder `visao.seudominio.com`:

   ```sh
   sudo cp deploy/nginx-visao.conf /etc/nginx/conf.d/visao.conf
   # editar server_name → cam.box3.software (e os caminhos de certificado, se manual)
   sudo certbot --nginx -d cam.box3.software   # reaproveita o certbot já presente na VPS
   sudo nginx -t && sudo systemctl reload nginx
   ```

   Atenção (VPS compartilhada): se o `nginx.conf` existente já define o
   `map $http_upgrade $connection_upgrade`, remover o bloco duplicado do nosso conf.

5. **Cadastrar os canais de ingest no painel `/cameras`** — uma câmera por canal, com URL:

   ```
   rtsp://127.0.0.1:8554/causei_camN
   ```

   É esse cadastro que **liga** o canal `causei_camN`: o hub regenera o `go2rtc.yaml`, o go2rtc
   abre o listener `:1935` e cria o stream vazio que aceita o publish. Nada mais a configurar
   no servidor.

6. **Apontar o push na câmera** → `rtmp://cam.box3.software:1935/causei_camN`.

   **Lembrete Intelbras/Dahua:** o firmware pode **forçar o app `live`** e ignorar o path digitado —
   o push cai em `.../live` em vez de `.../causei_camN`. Se acontecer, o canal a cadastrar no passo 5
   é `live` (URL `rtsp://127.0.0.1:8554/live`). **Teste com 1 câmera primeiro** e confirme em qual
   canal o publish caiu antes de replicar para as demais. (Consequência: se todas as câmeras forçarem
   `live`, só cabe **uma** por hub nesse modo — anotar o comportamento por modelo em
   [`PENDENCIAS.md`](PENDENCIAS.md).)

7. **Validar**: tile da câmera aparece no painel em `https://cam.box3.software`, vídeo andando.

## Limites/segurança

- **RTMP sem auth.** O publish do go2rtc não autentica — a defesa é o **firewall** (passo 2):
  porta 1935 restrita ao IP de origem das câmeras. Não deixar 1935 aberta ao mundo em regime.
- **LGPD (ADR-002).** O go2rtc só **relaya** o vídeo (republish RTSP/WebRTC em memória) — **sem
  gravação** em disco. Nenhum frame é persistido no servidor; só metadados/indicadores.
- **Disco ~99%.** A VPS está no limite; o deploy já poda backups antigos, mas cuidado ao criar
  qualquer arquivo grande lá (logs, dumps). Nada neste runbook deve gravar vídeo.
- **VPS compartilhada e restrita.** Só o subdomínio e a porta 1935 são nossos; não tocar nas
  portas 80/443 além do server block próprio, nem em env/unit de outros serviços.
